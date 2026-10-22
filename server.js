import * as cheerio from 'cheerio';
import cors from 'cors';
import express from 'express';
import Parser from 'rss-parser';

const app = express();
const port = Number(process.env.PORT || 10000);
const githubRepo = process.env.GITHUB_REPO || 'jlfuertes14/Yomite';
const githubReleaseUrl = `https://api.github.com/repos/${githubRepo}/releases/latest`;
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const releaseSyncSecret = process.env.RELEASE_SYNC_SECRET || '';
const releaseCacheTtlMs = 5 * 60 * 1000;
const feedParser = new Parser({ timeout: 15000 });
const annFeedUrls = [
  'https://www.animenewsnetwork.com/news/rss.xml?ann-edition=us',
  'https://www.animenewsnetwork.com/all/rss.xml?ann-edition=us',
  'https://www.animenewsnetwork.com/all/rss.xml',
];
const animeCornerFeedUrl = 'https://animecorner.me/feed/';

const feedCache = { value: null, expiresAt: 0 };
const articleCache = new Map();
const releaseCache = { value: null, expiresAt: 0 };
const feedTtlMs = 15 * 60 * 1000;
const articleTtlMs = 60 * 60 * 1000;

function logReleaseEvent(message, details = {}) {
  console.info(`[yomite-releases] ${message}`, details);
}

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

async function supabaseRequest(path, options = {}) {
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase service configuration is missing');
  }

  const method = options.method || 'GET';
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: supabaseServiceRoleKey,
      Authorization: `Bearer ${supabaseServiceRoleKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    logReleaseEvent('Supabase request failed', {
      method,
      path: path.split('?')[0],
      status: response.status,
      body: errorBody.slice(0, 300),
    });
    throw new Error(`Supabase request failed with ${response.status}`);
  }

  if (response.status === 204) return null;

  // PostgREST returns an empty body for requests using Prefer: return=minimal.
  // Do not attempt response.json() on that successful empty response.
  const responseText = await response.text();
  logReleaseEvent('Supabase request succeeded', {
    method,
    path: path.split('?')[0],
    status: response.status,
    hasBody: Boolean(responseText.trim()),
  });
  if (!responseText.trim()) return null;

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error('Supabase returned an invalid JSON response');
  }
}

function normalizeRelease(data) {
  const tagName = String(data?.tag_name || '').trim();
  const version = tagName.replace(/^v/i, '');
  const assets = Array.isArray(data?.assets) ? data.assets : [];
  const apk = assets.find((asset) => String(asset?.name || '').includes('universal.apk'))
    || assets.find((asset) => String(asset?.name || '').endsWith('.apk'));

  if (!version || !apk?.browser_download_url) return null;

  return {
    version,
    tagName,
    releaseTitle: data.name || `Yomite v${version}`,
    releaseNotes: String(data.body || '').trim() || 'No release notes provided for this version.',
    downloadUrl: apk.browser_download_url,
    fileName: apk.name || `Yomite-${version}.apk`,
    apkSize: Number(apk.size || 0),
    publishedAt: data.published_at || new Date().toISOString(),
    htmlUrl: data.html_url || `https://github.com/${githubRepo}/releases/tag/${tagName}`,
    channel: 'stable',
  };
}

async function fetchGitHubLatestRelease() {
  const response = await fetch(githubReleaseUrl, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Yomite-Release-Service',
    },
  });

  if (!response.ok) throw new Error(`GitHub release request failed with ${response.status}`);
  return normalizeRelease(await response.json());
}

async function getStoredLatestRelease() {
  const rows = await supabaseRequest(
    'yomite_releases?channel=eq.stable&select=*&order=published_at.desc&limit=1'
  );
  return Array.isArray(rows) && rows[0] ? {
    version: rows[0].version,
    tagName: rows[0].tag_name,
    releaseTitle: rows[0].release_title,
    releaseNotes: rows[0].release_notes,
    downloadUrl: rows[0].download_url,
    fileName: rows[0].file_name,
    apkSize: rows[0].apk_size,
    publishedAt: rows[0].published_at,
    htmlUrl: rows[0].html_url,
    channel: rows[0].channel,
    releaseId: rows[0].id,
  } : null;
}

async function getLatestRelease() {
  if (releaseCache.value && releaseCache.expiresAt > Date.now()) return releaseCache.value;

  let stored = null;
  try {
    stored = await getStoredLatestRelease();
  } catch (error) {
    console.warn('[release-service] Stored release lookup failed; using GitHub fallback:', error.message);
  }
  const release = stored || await fetchGitHubLatestRelease();
  if (!release) return null;

  releaseCache.value = release;
  releaseCache.expiresAt = Date.now() + releaseCacheTtlMs;
  return release;
}

async function saveRelease(release) {
  const rows = await supabaseRequest('yomite_releases?on_conflict=version', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      version: release.version,
      tag_name: release.tagName,
      release_title: release.releaseTitle,
      release_notes: release.releaseNotes,
      download_url: release.downloadUrl,
      file_name: release.fileName,
      apk_size: release.apkSize,
      published_at: release.publishedAt,
      html_url: release.htmlUrl,
      channel: release.channel,
    }),
  });
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function sendReleasePush(release) {
  const subscriptions = await supabaseRequest(
    "yomite_release_subscriptions?enabled=eq.true&platform=eq.android&channel=eq.stable&select=push_token"
  );
  const tokens = [...new Set((subscriptions || []).map((row) => row.push_token).filter(Boolean))];
  if (tokens.length === 0) return 0;

  for (let offset = 0; offset < tokens.length; offset += 100) {
    const messages = tokens.slice(offset, offset + 100).map((token) => ({
      to: token,
      title: `Yomite v${release.version} is available`,
      body: release.releaseTitle || 'A new Yomite update is ready.',
      sound: 'default',
      priority: 'high',
      channelId: 'yomite_chapter_updates',
      data: { type: 'app-update', version: release.version, releaseId: release.releaseId },
    }));

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!response.ok) throw new Error(`Expo push request failed with ${response.status}`);
  }

  return tokens.length;
}

async function syncLatestRelease() {
  const release = await fetchGitHubLatestRelease();
  if (!release) throw new Error('Latest GitHub release has no installable APK asset');

  const existing = await supabaseRequest(
    `yomite_releases?version=eq.${encodeURIComponent(release.version)}&select=id,notifications_sent_at&limit=1`
  );
  const stored = await saveRelease(release);
  const alreadyNotified = existing?.[0]?.notifications_sent_at;
  let notifiedCount = 0;

  if (!alreadyNotified && stored) {
    notifiedCount = await sendReleasePush({ ...release, releaseId: stored.id });
    await supabaseRequest(`yomite_releases?id=eq.${stored.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ notifications_sent_at: new Date().toISOString() }),
    });
  }

  releaseCache.value = { ...release, releaseId: stored?.id };
  releaseCache.expiresAt = Date.now() + releaseCacheTtlMs;
  return { release: releaseCache.value, notifiedCount };
}

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

function getOriginalWordPressUrl(url) {
  if (!url) return '';
  // Remove WordPress resize dimension suffix e.g. -1024x576.jpg -> .jpg
  return url.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)(\?.*)?$/, '$1');
}

function normalizeImageKey(url) {
  if (!url) return '';
  const clean = getOriginalWordPressUrl(url).split('?')[0];
  const filename = clean.split('/').pop() || clean;
  return filename.toLowerCase();
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
  if (feedCache.value && feedCache.expiresAt > Date.now()) {
    logReleaseEvent('News feed cache hit', { itemCount: feedCache.value.length });
    return feedCache.value;
  }

  const results = [];
  logReleaseEvent('News feed refresh started', {
    annSources: annFeedUrls.length,
    animeCornerSource: true,
  });

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
        logReleaseEvent('Anime News Network feed loaded', {
          source: new URL(feedUrl).hostname,
          itemCount: items.length,
        });
        break;
      }
      logReleaseEvent('Anime News Network feed returned no usable items', {
        source: new URL(feedUrl).hostname,
      });
    } catch (error) {
      logReleaseEvent('Anime News Network feed failed', {
        source: new URL(feedUrl).hostname,
        error: error.message || 'unknown error',
      });
    }
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
    logReleaseEvent('Anime Corner feed loaded', { itemCount: acItems.length });
  } catch (acErr) {
    logReleaseEvent('Anime Corner feed failed', { error: acErr.message || 'unknown error' });
  }

  // 3. Sort chronologically by posting timestamp descending (newest first)
  results.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

  if (results.length > 0) {
    logReleaseEvent('News feed enrichment started', { itemCount: Math.min(results.length, 20) });
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
      } catch (error) {
        logReleaseEvent('News article enrichment failed', {
          source: item.source,
          error: error.message || 'unknown error',
        });
        return item;
      }
    }));
    const mergedItems = [...enrichedItems, ...results.slice(20)];
    feedCache.value = mergedItems;
    feedCache.expiresAt = Date.now() + feedTtlMs;
    logReleaseEvent('News feed refresh completed', { itemCount: mergedItems.length });
    return mergedItems;
  }

  logReleaseEvent('News feed refresh failed: no usable items');
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

  logReleaseEvent('News article request started', { source: sourceName });

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

  // 2. Resolve Article Content Container Scope
  const targetScope = isAc
    ? ($('.entry-content').first().length ? $('.entry-content').first() : $('.ac-single-entry').first().length ? $('.ac-single-entry').first() : $('article').first())
    : ($('#content-zone .meat').first().length ? $('#content-zone .meat').first() : $('.meat').first().length ? $('.meat').first() : $('article').first());

  // Primary cover image (clean original version)
  const ogImageRaw = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || $('link[rel="image_src"]').attr('href');
  const cleanOgImage = ogImageRaw ? getOriginalWordPressUrl(toAbsoluteUrl(ogImageRaw, url)) : undefined;

  // Extract the REAL visual arts & key visuals strictly from within article body
  const rawBodyImages = [];
  const seenKeys = new Set();

  targetScope.find('img').each((_, element) => {
    const el = $(element);
    const cls = el.attr('class') || '';
    const src = el.attr('src') || '';
    const parentCls = el.parent().attr('class') || '';
    const grandParentCls = el.parent().parent().attr('class') || '';

    if (
      cls.includes('avatar') ||
      cls.includes('author') ||
      cls.includes('wp-smiley') ||
      parentCls.includes('author') ||
      parentCls.includes('avatar') ||
      parentCls.includes('penci-post-related') ||
      grandParentCls.includes('penci-post-related') ||
      src.includes('150x150') ||
      src.includes('gravatar') ||
      src.includes('/system/') ||
      src.includes('icon-') ||
      src.includes('favicon')
    ) {
      return;
    }

    const srcsetBest = parseHighestResFromSrcset(el.attr('srcset') || el.attr('data-srcset'));
    const candidate = srcsetBest
      || el.attr('data-src')
      || el.attr('data-lazy-src')
      || src;

    if (candidate && !candidate.startsWith('data:') && !candidate.includes('150x150') && !candidate.includes('gravatar')) {
      const absUrl = toAbsoluteUrl(candidate, url);
      if (absUrl) {
        const originalUrl = getOriginalWordPressUrl(absUrl);
        const key = normalizeImageKey(originalUrl);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          rawBodyImages.push(originalUrl);
        }
      }
    }
  });

  const primaryCover = cleanOgImage || rawBodyImages[0];
  const coverKey = normalizeImageKey(primaryCover);

  // If anime news content has only one image and it's already used as the cover image (or is the cover image),
  // do not include it in visuals so that the Official Visuals gallery is not redundantly rendered.
  const nonCoverBodyImages = rawBodyImages.filter((img) => normalizeImageKey(img) !== coverKey);
  const visuals = nonCoverBodyImages.length > 0
    ? nonCoverBodyImages
    : (rawBodyImages.length > 1 ? rawBodyImages : []);

  // 3. Clean Article Text, Sub-headlines, Lists & Quotes
  const content = [];
  const introText = cleanText($('.intro').first().text());

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
    imageUrl: primaryCover,
    images: visuals,
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

app.get('/api/releases/latest', async (req, res) => {
  try {
    const release = await getLatestRelease();
    if (!release) return res.status(404).json({ error: 'No release available' });

    const etag = `\"${release.version}\"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'public, max-age=300');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.json(release);
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Release unavailable' });
  }
});

app.post('/api/releases/sync', async (req, res) => {
  if (!releaseSyncSecret || req.get('x-release-sync-secret') !== releaseSyncSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await syncLatestRelease();
    return res.json({ ok: true, version: result.release.version, notified: result.notifiedCount });
  } catch (error) {
    return res.status(502).json({ error: error.message || 'Release sync failed' });
  }
});

app.post('/api/releases/subscribe', async (req, res) => {
  const pushToken = String(req.body?.pushToken || '').trim();
  const platform = String(req.body?.platform || 'android').trim().toLowerCase();
  const channel = String(req.body?.channel || 'stable').trim().toLowerCase();
  const appVersion = String(req.body?.appVersion || '').trim();

  logReleaseEvent('Subscription request received', {
    platform,
    channel,
    appVersion,
    hasPushToken: Boolean(pushToken),
    tokenFormatValid: /^ExponentPushToken\[.+\]$/.test(pushToken),
  });

  if (!pushToken || !/^ExponentPushToken\[.+\]$/.test(pushToken)) {
    return res.status(400).json({ error: 'A valid Expo push token is required' });
  }

  try {
    await supabaseRequest('yomite_release_subscriptions?on_conflict=push_token', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        push_token: pushToken,
        platform,
        channel,
        app_version: appVersion || null,
        enabled: true,
        last_seen_at: new Date().toISOString(),
      }),
    });
    logReleaseEvent('Subscription saved', { platform, channel, appVersion });
    return res.json({ ok: true });
  } catch (error) {
    logReleaseEvent('Subscription failed', {
      platform,
      channel,
      appVersion,
      error: error.message || 'unknown error',
    });
    return res.status(502).json({ error: error.message || 'Subscription failed' });
  }
});

app.post('/api/releases/unsubscribe', async (req, res) => {
  const pushToken = String(req.body?.pushToken || '').trim();
  logReleaseEvent('Unsubscribe request received', { hasPushToken: Boolean(pushToken) });
  if (!pushToken) return res.status(400).json({ error: 'Push token is required' });

  try {
    await supabaseRequest(`yomite_release_subscriptions?push_token=eq.${encodeURIComponent(pushToken)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ enabled: false, last_seen_at: new Date().toISOString() }),
    });
    logReleaseEvent('Subscription disabled');
    return res.json({ ok: true });
  } catch (error) {
    logReleaseEvent('Unsubscribe failed', { error: error.message || 'unknown error' });
    return res.status(502).json({ error: error.message || 'Unsubscribe failed' });
  }
});

app.get('/api/news', async (_req, res) => {
  logReleaseEvent('News API request received');
  try {
    const items = await fetchFeed();
    logReleaseEvent('News API request succeeded', { itemCount: items.length });
    res.json({ source: 'Aggregated Anime News', items });
  } catch (error) {
    logReleaseEvent('News API request failed', { error: error.message || 'unknown error' });
    res.status(502).json({ error: 'Anime news feeds unavailable' });
  }
});

app.get('/api/news/article', async (req, res) => {
  logReleaseEvent('News article API request received', {
    hasUrl: Boolean(req.query.url),
  });
  try {
    const url = String(req.query.url || '');
    const article = await fetchArticle(url);
    logReleaseEvent('News article API request succeeded');
    res.json(article);
  } catch (error) {
    logReleaseEvent('News article API request failed', {
      status: error.statusCode || 502,
      error: error.message || 'unknown error',
    });
    res.status(error.statusCode || 502).json({ error: error.message || 'Article unavailable' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`yomite-parser listening on ${port}`);
});
