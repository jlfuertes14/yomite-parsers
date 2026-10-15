import * as cheerio from 'cheerio';
import cors from 'cors';
import express from 'express';
import Parser from 'rss-parser';

const app = express();
const port = Number(process.env.PORT || 10000);
const feedParser = new Parser({ timeout: 15000 });
const annFeedUrls = [
  'https://www.animenewsnetwork.com/news/rss.xml?ann-edition=us',
  'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',
  'https://www.animenewsnetwork.com/all/rss.xml',
];
const animeCornerFeedUrl = 'https://animecorner.me/feed/';

const feedCache = { value: null, expiresAt: 0 };
const articleCache = new Map();
const feedTtlMs = 15 * 60 * 1000;
const articleTtlMs = 60 * 60 * 1000;

const allowedOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin is not allowed'));
  },
}));
app.use(express.json({ limit: '1mb' }));

function isAllowedArticleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (
      url.hostname === 'animenewsnetwork.com' || url.hostname.endsWith('.animenewsnetwork.com') ||
      url.hostname === 'animecorner.me' || url.hostname.endsWith('.animecorner.me')
    );
  } catch {
    return false;
  }
}

function cleanText(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function getImageUrl(item) {
  return item.enclosure?.url || item.enclosure?.link || item['media:content']?.url || item['media:thumbnail']?.url;
}

function getYoutubeEmbedUrl(value) {
  if (!value) return undefined;
  try {
    const raw = String(value).trim();
    // Direct YouTube video ID (11 chars)
    if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
      const embedUrl = new URL(`https://www.youtube.com/embed/${raw}`);
      embedUrl.searchParams.set('origin', 'https://yomite.vercel.app');
      embedUrl.searchParams.set('enablejsapi', '1');
      return embedUrl.toString();
    }

    const url = new URL(raw, 'https://animecorner.me');
    let videoId;
    if (url.searchParams.get('yt_embed')) {
      videoId = url.searchParams.get('yt_embed');
    } else if (url.hostname === 'youtu.be') {
      videoId = url.pathname.replace(/^\/+/, '').split('/')[0];
    } else if (url.hostname.includes('youtube.com')) {
      videoId = url.searchParams.get('v')
        || url.pathname.match(/\/embed\/([^/?]+)/)?.[1]
        || url.pathname.match(/\/shorts\/([^/?]+)/)?.[1];
    }
    if (!videoId) return undefined;
    const embedUrl = new URL(`https://www.youtube.com/embed/${videoId}`);
    embedUrl.searchParams.set('origin', 'https://yomite.vercel.app');
    embedUrl.searchParams.set('enablejsapi', '1');
    return embedUrl.toString();
  } catch {
    return undefined;
  }
}

function parseHighestResFromSrcset(srcset) {
  if (!srcset) return null;
  const parts = srcset.split(',').map((part) => {
    const [u, w] = part.trim().split(/\s+/);
    const width = parseInt(w?.replace(/\D/g, '') || '0', 10);
    return { url: u, width };
  }).filter((p) => p.url && !p.url.startsWith('data:'));
  if (parts.length === 0) return null;
  parts.sort((a, b) => b.width - a.width);
  return parts[0].url;
}

function toAbsoluteUrl(value, baseUrl) {
  if (!value) return undefined;
  try {
    let clean = String(value).trim();
    if (clean.startsWith('//')) clean = 'https:' + clean;
    // Upgrade ANN max300x600 to max600x600 for high-res clarity
    if (clean.includes('animenewsnetwork.com/thumbnails/max300x600/')) {
      clean = clean.replace('thumbnails/max300x600/', 'thumbnails/max600x600/');
    }
    return new URL(clean, baseUrl).toString();
  } catch {
    return undefined;
  }
}

async function fetchFeed() {
  if (feedCache.value && feedCache.expiresAt > Date.now()) return feedCache.value;

  const results = [];

  // 1. Fetch Anime News Network
  for (const feedUrl of annFeedUrls) {
    try {
      const feed = await feedParser.parseURL(feedUrl);
      const items = feed.items.map((item, index) => ({
        id: String(item.guid || item.link || `ann-${index}`),
        title: cleanText(item.title || 'Anime news update'),
        summary: cleanText(item.contentSnippet || item.content || 'Read the latest update from Anime News Network.'),
        publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
        url: item.link || '',
        imageUrl: getImageUrl(item),
        source: 'Anime News Network',
      })).filter((item) => item.url);

      if (items.length > 0) {
        results.push(...items);
        break;
      }
    } catch { }
  }

  // 2. Fetch Anime Corner
  try {
    const acFeed = await feedParser.parseURL(animeCornerFeedUrl);
    const acItems = acFeed.items.map((item, index) => ({
      id: String(item.guid || item.link || `ac-${index}`),
      title: cleanText(item.title || 'Anime Corner update'),
      summary: cleanText(item.contentSnippet || item.content || 'Read the latest update from Anime Corner.'),
      publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
      url: item.link || '',
      imageUrl: getImageUrl(item),
      source: 'Anime Corner',
    })).filter((item) => item.url);

    if (acItems.length > 0) {
      results.push(...acItems);
    }
  } catch (acErr) {
    console.warn('Anime Corner feed fetch failed:', acErr.message);
  }

  // 3. Sort chronologically by posting timestamp descending (newest first)
  results.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  if (results.length > 0) {
    const enrichedItems = await Promise.all(results.slice(0, 20).map(async (item) => {
      try {
        const article = await fetchArticle(item.url);
        return {
          ...item,
          imageUrl: article.imageUrl || item.imageUrl,
          images: article.images,
          trailerUrl: article.trailerUrl,
          trailerUrls: article.trailerUrls,
        };
      } catch {
        return item;
      }
    }));
    const mergedItems = [...enrichedItems, ...results.slice(20)];
    feedCache.value = mergedItems;
    feedCache.expiresAt = Date.now() + feedTtlMs;
    return mergedItems;
  }

  throw new Error('Anime news feeds unavailable');
}

async function fetchArticle(url) {
  if (!isAllowedArticleUrl(url)) {
    const error = new Error('Only Anime News Network and Anime Corner article URLs are supported');
    error.statusCode = 400;
    throw error;
  }

  const cached = articleCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const isAc = url.includes('animecorner.me');
  const sourceName = isAc ? 'Anime Corner' : 'Anime News Network';

  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Yomite Parser/1.0 (+https://yomite.vercel.app)',
    },
  });
  if (!response.ok) throw new Error(`Article request failed with ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);

  // 1. Promotional Videos (PV) / Trailers
  const trailerUrls = $('iframe, a, div[data-video-id], div[data-youtube-id]')
    .map((_, element) => getYoutubeEmbedUrl(
      $(element).attr('src')
        || $(element).attr('data-src')
        || $(element).attr('data-lazy-src')
        || $(element).attr('href')
        || $(element).attr('data-video-id')
        || $(element).attr('data-youtube-id')
    ))
    .get()
    .filter(Boolean)
    .filter((v, index, values) => values.indexOf(v) === index);

  // 2. High-res Images & Galleries
  const rawImageUrls = [
    $('meta[property="og:image"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('link[rel="image_src"]').attr('href'),
    parseHighestResFromSrcset($('link[rel="preload"][as="image"]').attr('imagesrcset')),
    $('link[rel="preload"][as="image"]').attr('href'),
  ];

  // Also extract any JSON-LD primary image if available
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const data = JSON.parse($(element).html() || '{}');
      const graph = data['@graph'] || (Array.isArray(data) ? data : [data]);
      for (const node of graph) {
        if (node.thumbnailUrl) rawImageUrls.push(node.thumbnailUrl);
        if (node.image?.url) rawImageUrls.push(node.image.url);
        if (node.contentUrl && node['@type'] === 'ImageObject') rawImageUrls.push(node.contentUrl);
      }
    } catch {}
  });

  // Comprehensive image selectors covering ANN (.meat, figure, #content-zone) and Anime Corner (.entry-content, .ac-single-entry)
  $('article img, main img, #content-zone img, .meat img, .entry-content img, .ac-single-entry img, figure img, .wp-block-image img').each((_, element) => {
    const cls = $(element).attr('class') || '';
    const src = $(element).attr('src') || '';
    if (
      cls.includes('avatar') ||
      cls.includes('author') ||
      src.includes('bookmark-shorturl') ||
      src.includes('/system/') ||
      src.includes('icon-') ||
      src.includes('favicon')
    ) {
      return;
    }

    const srcsetBest = parseHighestResFromSrcset($(element).attr('srcset') || $(element).attr('data-srcset'));
    const candidate = srcsetBest
      || $(element).attr('data-src')
      || $(element).attr('data-lazy-src')
      || src;

    if (candidate && !candidate.startsWith('data:') && !candidate.includes('150x150') && !candidate.includes('gravatar')) {
      rawImageUrls.push(candidate);
    }
  });

  const imageUrls = rawImageUrls
    .map((value) => toAbsoluteUrl(value, url))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 30);

  // 3. Clean Article Text, Sub-headlines, Lists & Quotes
  const content = [];

  const introText = cleanText($('.intro').first().text());
  if (introText && introText.length > 10) {
    content.push(introText);
  }

  targetScope.find('p, ul, blockquote').each((_, element) => {
    const el = $(element);
    const parentClass = el.parent().attr('class') || '';
    if (
      parentClass.includes('author') ||
      parentClass.includes('comment') ||
      parentClass.includes('panel') ||
      parentClass.includes('ezoic') ||
      parentClass.includes('ezmob') ||
      parentClass.includes('social')
    ) {
      return;
    }

    const tagName = element.tagName ? element.tagName.toLowerCase() : '';
    if (tagName === 'ul') {
      el.find('li').each((__, li) => {
        const item = cleanText($(li).text());
        if (item.length > 3) content.push(`• ${item}`);
      });
    } else if (tagName === 'blockquote') {
      const quote = cleanText(el.text());
      if (quote.length > 15) content.push(`“${quote}”`);
    } else {
      const txt = cleanText(el.text());
      if (
        txt.length > 20 &&
        !txt.startsWith('Disclosure:') &&
        !txt.includes('discuss this in the forum') &&
        !txt.includes('bookmark/share with')
      ) {
        content.push(txt);
      }
    }
  });

  // Clean title: remove any leftover "News" subtitle prefix from ANN page_header
  let title = cleanText($('meta[property="og:title"]').attr('content') || '');
  if (!title) {
    const headerEl = $('#page_header').clone();
    headerEl.find('.sub-title').remove();
    title = cleanText(headerEl.text() || $('title').text());
  }

  let summary = cleanText($('meta[property="og:description"]').attr('content') || '');
  if (!summary && introText) {
    summary = introText;
  }

  const value = {
    title,
    summary,
    imageUrl: imageUrls[0],
    images: imageUrls,
    trailerUrl: trailerUrls[0],
    trailerUrls,
    publishedAt: $('meta[property="article:published_time"]').attr('content')
      || $('time').first().attr('datetime')
      || undefined,
    url,
    source: sourceName,
    content: content.slice(0, 100),
  };

  articleCache.set(url, { value, expiresAt: Date.now() + articleTtlMs });
  return value;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'yomite-parser' });
});

app.get('/api/news', async (_req, res) => {
  try {
    res.json({ source: 'Aggregated Anime News', items: await fetchFeed() });
  } catch {
    res.status(502).json({ error: 'Anime news feeds unavailable' });
  }
});

app.get('/api/news/article', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    res.json(await fetchArticle(url));
  } catch (error) {
    res.status(error.statusCode || 502).json({ error: error.message || 'Article unavailable' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`yomite-parser listening on ${port}`);
});
