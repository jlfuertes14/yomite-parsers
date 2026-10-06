import express from 'express';
import cors from 'cors';
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';

const app = express();
const port = Number(process.env.PORT || 10000);
const feedParser = new Parser({ timeout: 15000 });
const feedUrls = [
  'https://www.animenewsnetwork.com/news/rss.xml?ann-edition=us',
  'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',
  'https://www.animenewsnetwork.com/all/rss.xml',
];
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
      url.hostname === 'animenewsnetwork.com' || url.hostname.endsWith('.animenewsnetwork.com')
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
    const url = new URL(value);
    let videoId;
    if (url.hostname === 'youtu.be') {
      videoId = url.pathname.replace(/^\/+/, '').split('/')[0];
    } else if (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) {
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

function toAbsoluteUrl(value, baseUrl) {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

async function fetchFeed() {
  if (feedCache.value && feedCache.expiresAt > Date.now()) return feedCache.value;

  let lastError;
  for (const feedUrl of feedUrls) {
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
        const enrichedItems = await Promise.all(items.slice(0, 8).map(async (item) => {
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
        const mergedItems = [...enrichedItems, ...items.slice(8)];
        feedCache.value = mergedItems;
        feedCache.expiresAt = Date.now() + feedTtlMs;
        return mergedItems;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Anime News Network feed unavailable');
}

async function fetchArticle(url) {
  if (!isAllowedArticleUrl(url)) {
    const error = new Error('Only Anime News Network article URLs are supported');
    error.statusCode = 400;
    throw error;
  }

  const cached = articleCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Yomite Parser/1.0 (+https://yomite.vercel.app)',
    },
  });
  if (!response.ok) throw new Error(`Article request failed with ${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const trailerUrls = $('iframe, a')
    .map((_, element) => getYoutubeEmbedUrl(
      $(element).attr('src') || $(element).attr('data-src') || $(element).attr('href')
    ))
    .get()
    .filter(Boolean)
    .filter((url, index, values) => values.indexOf(url) === index);
  const imageUrls = [
    $('meta[property="og:image"]').attr('content'),
    $('meta[name="twitter:image"]').attr('content'),
    $('link[rel="image_src"]').attr('href'),
    ...$('article img, main img, figure img')
      .map((_, element) => $(element).attr('src') || $(element).attr('data-src') || $(element).attr('data-lazy-src'))
      .get(),
  ]
    .map((value) => toAbsoluteUrl(value, url))
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 30);
  $('script, style, noscript, nav, aside, footer, form, iframe').remove();

  const articleRoot = $('article').first().length ? $('article').first() : $('main').first();
  const paragraphs = articleRoot.find('p').map((_, element) => cleanText($(element).text())).get()
    .filter((paragraph) => paragraph.length > 25);
  const content = paragraphs.length > 0 ? paragraphs : $('p').map((_, element) => cleanText($(element).text())).get()
    .filter((paragraph) => paragraph.length > 25);

  const value = {
    title: cleanText($('meta[property="og:title"]').attr('content') || $('title').text()),
    summary: cleanText($('meta[property="og:description"]').attr('content') || ''),
    imageUrl: imageUrls[0],
    images: imageUrls,
    trailerUrl: trailerUrls[0],
    trailerUrls,
    publishedAt: $('meta[property="article:published_time"]').attr('content') || undefined,
    url,
    source: 'Anime News Network',
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
    res.json({ source: 'Anime News Network', items: await fetchFeed() });
  } catch (error) {
    res.status(502).json({ error: 'Anime News Network feed unavailable' });
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
