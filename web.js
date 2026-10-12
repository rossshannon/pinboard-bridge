const { XMLParser } = require('fast-xml-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const http = require('http');
const https = require('https');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const net = require('net');
const rateLimit = require('express-rate-limit');

// Environment variable validation
const PORT = process.env.PORT || 1337;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
  : null; // null means allow all origins (for backward compatibility)
const PINBOARD_BASE_URL = 'https://api.pinboard.in';
const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 5000;
// Everything a preview needs lives in <head>, so stop reading there. This cap
// only applies when a page never closes its <head>.
const PREVIEW_HEAD_MAX_BYTES = 512 * 1024;
// Pinboard asks for at most one API call per user every three seconds. Calls
// for the same user are spaced this far apart (start to start); set it to 0
// to turn spacing off.
const parseNonNegativeInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const PINBOARD_MIN_INTERVAL_MS = parseNonNegativeInt(process.env.PINBOARD_MIN_INTERVAL_MS, 3000);
// A call that would have to queue longer than this goes straight through
// instead, so a burst degrades to unspaced calls rather than piling up
// towards Heroku's 30s router timeout.
const PINBOARD_MAX_QUEUE_MS = parseNonNegativeInt(process.env.PINBOARD_MAX_QUEUE_MS, 9000);
// Browsers must preflight every call to this bridge (the Authorization
// header is not CORS-safelisted). Letting them cache the preflight verdict
// saves a full round trip on repeat requests to the same URL, e.g.
// /v1/tags/get. Chrome caps this at 2h, Firefox at 24h.
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 24 * 60 * 60;
// Pinboard asks clients for at most one call per user per three seconds,
// which works out at 300 per 15 minutes. Match that, rather than imposing a
// tighter ceiling that a single bookmarking session can trip.
const IP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const IP_RATE_LIMIT_MAX = Number.parseInt(process.env.IP_RATE_LIMIT_MAX, 10) || 300;

// Log startup configuration
console.log(`Starting Pinboard Bridge in ${NODE_ENV} mode`);
console.log(`Port: ${PORT}`);
console.log(`CORS: ${ALLOWED_ORIGINS ? `Restricted to ${ALLOWED_ORIGINS.length} origins` : 'All origins allowed (set ALLOWED_ORIGINS env var for security)'}`);

const app = express();
const server = http.createServer(app);

// Trust proxy - required for rate limiting behind Heroku
app.set('trust proxy', 1);

// Every response here is either a private, authenticated view of a
// Pinboard account or a health probe: nothing a browser should keep. Express
// would otherwise attach a validator ETag to each JSON body, which invites
// browsers to store bookmark and tag data in their disk cache and revalidate
// it. (The CORS preflight cache is separate and still honours
// Access-Control-Max-Age.)
app.disable('etag');
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Not needed for API
  crossOriginEmbedderPolicy: false,
}));

// Gzip/brotli response bodies. Heroku's router does not compress, and a large
// Pinboard account's /v1/tags/get is a couple of hundred KB of JSON that
// shrinks by roughly 80%.
app.use(compression());

// Rate limiting per IP for the generic proxy routes. CORS preflights are
// skipped: they never reach Pinboard, and counting them would halve the
// number of real requests a browser client could make.
const limiter = rateLimit({
  windowMs: IP_RATE_LIMIT_WINDOW_MS,
  max: IP_RATE_LIMIT_MAX,
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: 'Too many requests, please try again later.' },
  skip: req => req.method === 'OPTIONS',
});

app.use('/v1/', limiter);

// CORS configuration
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);

    // If ALLOWED_ORIGINS is not set, allow all origins (backward compatibility)
    if (!ALLOWED_ORIGINS) return callback(null, true);

    // Check if origin is in whitelist
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-HTTP-Method-Override', 'Origin', 'Accept', 'Authorization'],
  maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
};

app.use(cors(corsOptions));

// Respond immediately to CORS preflight checks
app.options('*', cors(corsOptions));

// Surface CORS rejections as JSON 403 errors
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed by CORS policy' });
  }

  console.error('Middleware error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
});

// XML parser configuration
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

const USER_AGENT = 'pinboard-bridge/2.0 (+https://github.com/rossshannon/pinboard-bridge)';

// Reuse TLS connections to api.pinboard.in rather than paying a fresh
// handshake on every call.
const pinboardAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

// Axios configuration with timeout
const apiRequestDefaults = {
  timeout: 30000, // 30 seconds timeout
  httpsAgent: pinboardAgent,
  headers: {
    'User-Agent': USER_AGENT
  }
};

const previewRequestConfig = {
  timeout: PREVIEW_TIMEOUT_MS,
  maxRedirects: 3,
  maxContentLength: PREVIEW_MAX_BYTES,
  maxBodyLength: PREVIEW_MAX_BYTES,
  responseType: 'stream',
  headers: {
    Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'User-Agent': USER_AGENT
  },
  validateStatus: status => status >= 200 && status < 400,
};

// Per-user spacing of Pinboard calls. Each user has a next free slot; a call
// takes the later of now and that slot, and pushes the slot one interval on.
const pinboardNextSlotAt = new Map();

const reservePinboardSlot = identity => {
  if (PINBOARD_MIN_INTERVAL_MS === 0) return 0;
  const key = String(identity || '').toLowerCase();
  const now = Date.now();
  if (pinboardNextSlotAt.size > 1000) {
    for (const [user, slotAt] of pinboardNextSlotAt) {
      if (slotAt < now) pinboardNextSlotAt.delete(user);
    }
  }
  const slotAt = Math.max(now, pinboardNextSlotAt.get(key) || 0);
  const waitMs = slotAt - now;
  if (waitMs > PINBOARD_MAX_QUEUE_MS) {
    return 0;
  }
  pinboardNextSlotAt.set(key, slotAt + PINBOARD_MIN_INTERVAL_MS);
  return waitMs;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// GET a Pinboard API URL on behalf of a user, spaced per user, and log how
// long it queued and how long Pinboard took. The URL is not logged: it can
// carry the auth token.
const pinboardGet = async (url, authContext, label) => {
  const waitMs = reservePinboardSlot(authContext.identity);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  const startedAt = Date.now();
  let outcome = 'ok';
  try {
    return await axios.get(url, authContext.requestConfig);
  } catch (error) {
    outcome = error.response?.status ? String(error.response.status) : (error.code || 'error');
    throw error;
  } finally {
    console.info(`[pinboard] user=${authContext.identity} call=${label} waitMs=${waitMs} upstreamMs=${Date.now() - startedAt} outcome=${outcome}`);
  }
};

const timed = async promise => {
  const startedAt = Date.now();
  try {
    return { value: await promise, ms: Date.now() - startedAt };
  } catch (error) {
    error.elapsedMs = Date.now() - startedAt;
    throw error;
  }
};

const buildSearchParams = query => {
  const params = new URLSearchParams();
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(item => params.append(key, item));
    } else {
      params.append(key, value);
    }
  });
  return params;
};

const decodeBasicCredentials = encoded => {
  const decoded = Buffer.from(encoded, 'base64').toString();
  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex === -1) {
    return { username: '', password: '' };
  }
  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1)
  };
};

const applyAuthContext = (req, queryParams) => {
  if (queryParams) {
    queryParams.delete('auth_token');
  }

  const authHeader = req.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const basicMatch = authHeader.match(/^Basic\s+(.+)$/i);

  if (basicMatch) {
    const { username, password } = decodeBasicCredentials(basicMatch[1]);
    if (!username || !password) {
      throw new Error('Invalid Basic authorization header');
    }
    return {
      requestConfig: {
        ...apiRequestDefaults,
        auth: { username, password }
      },
      identity: username
    };
  }

  if (bearerMatch) {
    const authToken = bearerMatch[1].trim();
    if (!authToken.includes(':')) {
      throw new Error('Invalid Bearer authorization header');
    }
    if (queryParams) {
      queryParams.set('auth_token', authToken);
    }
    return {
      requestConfig: { ...apiRequestDefaults },
      identity: authToken.split(':')[0] || 'token'
    };
  }

  throw new Error('Authorization header required');
};

const isPrivateHostname = hostname => {
  if (!hostname) return true;
  // Node's URL parser keeps IPv6 hosts wrapped in brackets (e.g. "[::1]"),
  // but net.isIP only recognises the unwrapped form.
  const bare = hostname.replace(/^\[|\]$/g, '');
  const lower = bare.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return true;
  }

  const ipVersion = net.isIP(bare);
  if (ipVersion === 4) {
    const octets = bare.split('.').map(Number);
    if (octets[0] === 10) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
  }

  if (ipVersion === 6) {
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  }

  return false;
};

const resolveAbsoluteUrl = (baseUrl, value) => {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch (err) {
    return null;
  }
};

const deriveSiteDomain = urlString => {
  try {
    const parsed = new URL(urlString);
    return parsed.hostname.replace(/^www\./i, '');
  } catch (err) {
    return null;
  }
};

const pickMetaValue = ($, selector, attributePreference = ['content', 'value', 'href']) => {
  const element = $(selector).first();
  if (!element || element.length === 0) {
    return null;
  }

  if (selector.toLowerCase().startsWith('meta')) {
    for (const attr of attributePreference) {
      const candidate = element.attr(attr);
      if (candidate && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  if (selector.toLowerCase().startsWith('link')) {
    const href = element.attr('href');
    return href && href.trim() ? href.trim() : null;
  }

  const text = element.text();
  return text && text.trim() ? text.trim() : null;
};

const pickMetaValueWithSource = ($, selectors) => {
  for (const selector of selectors) {
    const value = pickMetaValue($, selector);
    if (value) {
      return { value, source: selector };
    }
  }
  return { value: null, source: null };
};

const FAVICON_SELECTORS = [
  'link[rel="apple-touch-icon"]',
  'link[rel="apple-touch-icon-precomposed"]',
  'link[rel="icon"][type="image/png"]',
  'link[rel="icon"][type="image/svg+xml"]',
  'link[rel="mask-icon"]',
  'link[rel="icon"]',
  'link[rel="shortcut icon"]'
];

const selectFavicon = ($) => {
  for (const selector of FAVICON_SELECTORS) {
    const href = pickMetaValue($, selector, ['href']);
    if (href) {
      return href;
    }
  }
  return null;
};

const extractPreviewMetadata = (html, finalUrl, originalUrl) => {
  const $ = cheerio.load(html);

  const title = pickMetaValue($, 'meta[name="twitter:title"]')
    || pickMetaValue($, 'meta[property="og:title"]')
    || pickMetaValue($, 'meta[name="title"]')
    || pickMetaValue($, 'title');

  const description = pickMetaValue($, 'meta[name="twitter:description"]')
    || pickMetaValue($, 'meta[property="og:description"]')
    || pickMetaValue($, 'meta[name="description"]');

  const rawImage = pickMetaValue($, 'meta[name="twitter:image"]')
    || pickMetaValue($, 'meta[name="twitter:image:src"]')
    || pickMetaValue($, 'meta[property="og:image"]');

  const siteName = pickMetaValue($, 'meta[property="og:site_name"]')
    || pickMetaValue($, 'meta[name="application-name"]');

  const siteHandleCandidate = pickMetaValueWithSource($, [
    'meta[name="twitter:site"]',
    'meta[name="twitter:creator"]'
  ]);
  const siteHandle = siteHandleCandidate.value;

  let siteHandleUrl = null;
  if (siteHandle && siteHandleCandidate.source?.includes('twitter')) {
    const normalizedHandle = siteHandle.replace(/^@/, '').trim();
    if (normalizedHandle) {
      siteHandleUrl = `https://twitter.com/${normalizedHandle}`;
    }
  }

  const cardType = pickMetaValue($, 'meta[name="twitter:card"]');

  const canonical = pickMetaValue($, 'link[rel="canonical"]')
    || pickMetaValue($, 'meta[property="og:url"]')
    || pickMetaValue($, 'meta[name="twitter:url"]');

  const canonicalUrl = resolveAbsoluteUrl(finalUrl, canonical) || finalUrl || originalUrl;
  const imageUrl = resolveAbsoluteUrl(canonicalUrl, rawImage);
  const siteDomain = deriveSiteDomain(canonicalUrl || originalUrl);

  const themeColor = pickMetaValue($, 'meta[name="theme-color"]')
    || pickMetaValue($, 'meta[name="msapplication-TileColor"]')
    || pickMetaValue($, 'meta[name="msapplication-navbutton-color"]');

  const rawFavicon = selectFavicon($);
  const faviconUrl = resolveAbsoluteUrl(canonicalUrl || finalUrl || originalUrl, rawFavicon);

  if (!title && !description && !imageUrl) {
    return null;
  }

  return {
    url: canonicalUrl,
    title: title || null,
    description: description || null,
    imageUrl: imageUrl || null,
    siteName: siteName || null,
    siteHandle: siteHandle || null,
    siteHandleUrl,
    siteDomain: siteDomain || null,
    cardType: cardType || null,
    themeColor: themeColor || null,
    faviconUrl: faviconUrl || null,
    fetchedAt: new Date().toISOString(),
    status: 'fresh'
  };
};

const HEAD_CLOSE = '</head';

// Read a streamed response until </head> (or the byte cap) and drop the rest
// of the page. Non-stream bodies (strings, buffers) are returned as they are.
const readHead = async data => {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (!data || typeof data.on !== 'function') return String(data || '');

  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      data.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    data.on('data', chunk => {
      // Search from a little before this chunk so a tag split across two
      // chunks is still found.
      const searchFrom = Math.max(0, length - HEAD_CLOSE.length);
      chunks.push(chunk);
      length += chunk.length;
      const tail = Buffer.concat(chunks).subarray(searchFrom).toString('latin1').toLowerCase();
      if (tail.includes(HEAD_CLOSE) || length >= PREVIEW_HEAD_MAX_BYTES) {
        finish();
      }
    });
    data.on('end', finish);
    data.on('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};

const fetchPreview = async targetUrl => {
  // One deadline for the whole fetch (redirects and body included), not just
  // for each socket going quiet.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const response = await axios.get(targetUrl.toString(), {
      ...previewRequestConfig,
      signal: controller.signal
    });
    const finalUrl = response.request?.res?.responseUrl || targetUrl.toString();
    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      if (response.data && typeof response.data.destroy === 'function') {
        response.data.destroy();
      }
      throw new Error('Preview response is not HTML');
    }

    const body = await readHead(response.data);
    return extractPreviewMetadata(body, finalUrl, targetUrl.toString());
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Preview fetch timed out after ${PREVIEW_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
};

// Validate the ?url= target shared by the preview routes. Returns the parsed
// URL, or sends a 400 and returns null.
const parsePreviewTarget = (req, res) => {
  const target = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!target) {
    res.status(400).json({ error: 'url query parameter is required' });
    return null;
  }

  let normalizedUrl;
  try {
    normalizedUrl = new URL(target);
  } catch (err) {
    res.status(400).json({ error: 'Invalid url parameter' });
    return null;
  }

  if (!['http:', 'https:'].includes(normalizedUrl.protocol)) {
    res.status(400).json({ error: 'URL must use http or https' });
    return null;
  }

  if (isPrivateHostname(normalizedUrl.hostname)) {
    res.status(400).json({ error: 'URL host is not reachable from the proxy' });
    return null;
  }

  return normalizedUrl;
};

// Turn a settled preview fetch into the fields both preview routes return.
const summarisePreview = result => {
  if (result.status === 'fulfilled') {
    const preview = result.value.value;
    return {
      preview,
      previewStatus: preview ? (preview.status || 'fresh') : 'no_data',
      previewError: null,
      previewMs: result.value.ms
    };
  }
  return {
    preview: null,
    previewStatus: 'error',
    previewError: result.reason?.message || 'Failed to fetch preview metadata',
    previewMs: result.reason?.elapsedMs ?? null
  };
};

const previewOutcome = ({ preview, previewError }) =>
  preview ? 'preview_generated' : (previewError ? 'preview_failed' : 'preview_not_found');

// Pinboard's published policy is one call per user per 3 seconds, so 20/min
// is the maximum sustained rate their /posts/suggest endpoint will accept
// before rate-limiting drops requests (observed as silent TCP hang-ups).
const PREVIEW_RATE_LIMIT_MAX = Number.parseInt(process.env.PREVIEW_RATE_LIMIT_MAX, 10) || 20;
const suggestWithPreviewRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: PREVIEW_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many preview requests, please slow down.' },
  keyGenerator: req => req.headers['authorization'] || req.ip,
});

// /preview never calls Pinboard, so it only needs a guard against scraping.
const PAGE_PREVIEW_RATE_LIMIT_MAX = Number.parseInt(process.env.PAGE_PREVIEW_RATE_LIMIT_MAX, 10) || 60;
const pagePreviewRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: PAGE_PREVIEW_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many preview requests, please slow down.' },
  keyGenerator: req => req.headers['authorization'] || req.ip,
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Page preview on its own: no Pinboard call, so it returns as soon as the
// page has been read, however slow Pinboard's suggest is.
app.get('/preview', pagePreviewRateLimiter, async (req, res) => {
  try {
    const normalizedUrl = parsePreviewTarget(req, res);
    if (!normalizedUrl) return;

    let authContext;
    try {
      authContext = applyAuthContext(req, null);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    const [previewResult] = await Promise.allSettled([timed(fetchPreview(normalizedUrl))]);
    const { preview, previewStatus, previewError, previewMs } = summarisePreview(previewResult);

    const payload = { preview, previewStatus };
    if (previewError) {
      payload.previewError = previewError;
    }

    console.info(`[preview] route=preview user=${authContext.identity} host=${normalizedUrl.hostname} outcome=${previewOutcome({ preview, previewError })} previewMs=${previewMs}` + (previewError ? ` previewError="${previewError}"` : ''));

    return res.json(payload);
  } catch (error) {
    console.error('Preview handler error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Suggest with preview endpoint. Kept for older clients; it answers only once
// both halves are done, so newer clients call /preview and /v1/posts/suggest
// separately.
app.get('/posts/suggest-with-preview', suggestWithPreviewRateLimiter, async (req, res) => {
  try {
    const normalizedUrl = parsePreviewTarget(req, res);
    if (!normalizedUrl) return;

    const pinboardParams = new URLSearchParams();
    pinboardParams.set('url', normalizedUrl.toString());
    pinboardParams.set('format', 'json');

    let authContext;
    try {
      authContext = applyAuthContext(req, pinboardParams);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    const pinboardUrl = `${PINBOARD_BASE_URL}/v1/posts/suggest?${pinboardParams.toString()}`;
    const suggestionsPromise = timed(pinboardGet(pinboardUrl, authContext, 'posts/suggest'));
    const previewPromise = timed(fetchPreview(normalizedUrl));

    const [suggestionsResult, previewResult] = await Promise.allSettled([suggestionsPromise, previewPromise]);

    // Auth failures from Pinboard must surface to the caller. Everything else
    // degrades gracefully so a flaky Pinboard doesn't also wipe out the preview.
    const SUGGEST_HARD_FAIL_STATUSES = new Set([401, 403]);

    let suggestions = null;
    let suggestionsError = null;
    let suggestionsStatus = 'ok';
    let suggestMs = null;

    if (suggestionsResult.status === 'rejected') {
      const error = suggestionsResult.reason;
      const upstreamStatus = error.response?.status;
      suggestMs = error.elapsedMs ?? null;

      if (upstreamStatus && SUGGEST_HARD_FAIL_STATUSES.has(upstreamStatus)) {
        const message = typeof error.response.data === 'string'
          ? error.response.data
          : error.response.data?.error || 'API request failed';
        return res.status(upstreamStatus).json({ error: message });
      }

      suggestionsStatus = 'error';
      if (upstreamStatus) {
        suggestionsError = `Pinboard suggest returned ${upstreamStatus}`;
      } else if (error.code === 'ECONNABORTED') {
        suggestionsError = 'Pinboard suggest timed out';
      } else {
        suggestionsError = error.message || 'Pinboard suggest failed';
      }
      console.error('Pinboard suggest error:', error.message);
    } else {
      suggestions = suggestionsResult.value.value.data;
      suggestMs = suggestionsResult.value.ms;
    }

    const { preview, previewStatus, previewError, previewMs } = summarisePreview(previewResult);

    const payload = {
      suggestions,
      suggestionsStatus,
      preview,
      previewStatus
    };

    if (suggestionsError) {
      payload.suggestionsError = suggestionsError;
    }
    if (previewError) {
      payload.previewError = previewError;
    }

    console.info(`[preview] route=suggest-with-preview user=${authContext.identity} host=${normalizedUrl.hostname} outcome=${previewOutcome({ preview, previewError })} suggestions=${suggestionsStatus} suggestMs=${suggestMs} previewMs=${previewMs}` + (previewError ? ` previewError="${previewError}"` : '') + (suggestionsError ? ` suggestionsError="${suggestionsError}"` : ''));

    return res.json(payload);
  } catch (error) {
    console.error('Suggest preview handler error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Main proxy handler
app.get('/v1/*', async (req, res) => {
  try {
    const queryParams = buildSearchParams(req.query);
    let authContext;
    try {
      authContext = applyAuthContext(req, queryParams);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    const path = req.path; // This includes /v1/...
    let url = `${PINBOARD_BASE_URL}${path}`;

    const queryString = queryParams.toString();
    if (queryString) {
      url += `?${queryString}`;
    }

    // Make request to Pinboard API
    const response = await pinboardGet(url, authContext, path.replace(/^\/v1\//, ''));
    const { data, status } = response;

    if (status !== 200) {
      return res.status(status).send(data);
    }

    // If response is already JSON, return it
    if (req.query['format'] === 'json' || typeof data === 'object') {
      return res.json(data);
    }

    // Parse XML to JSON
    try {
      const jsonData = xmlParser.parse(data);
      res.json(jsonData);
    } catch (parseError) {
      console.error('XML parsing error:', parseError.message);
      return res.status(500).json({ error: 'Failed to parse XML response' });
    }
  } catch (error) {
    // Handle Axios errors
    if (error.response) {
      const status = error.response.status;
      const errorMessage = typeof error.response.data === 'string'
        ? error.response.data
        : error.response.data?.error || 'API request failed';
      return res.status(status).json({ error: errorMessage });
    }

    // Handle timeout errors
    if (error.code === 'ECONNABORTED') {
      console.error('Request timeout:', error.message);
      return res.status(504).json({ error: 'Gateway timeout' });
    }

    // Handle network-layer errors (DNS failure, connection refused, reset)
    if (['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(error.code)) {
      console.error('Pinboard API unreachable:', error.message);
      return res.status(503).json({ error: 'Pinboard API is unreachable' });
    }

    // Handle other errors
    console.error('Server error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('\nReceived shutdown signal, closing server gracefully...');

  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server };
