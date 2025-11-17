const { XMLParser } = require('fast-xml-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
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

// Log startup configuration
console.log(`Starting Pinboard Bridge in ${NODE_ENV} mode`);
console.log(`Port: ${PORT}`);
console.log(`CORS: ${ALLOWED_ORIGINS ? `Restricted to ${ALLOWED_ORIGINS.length} origins` : 'All origins allowed (set ALLOWED_ORIGINS env var for security)'}`);

const app = express();
const server = http.createServer(app);

// Trust proxy - required for rate limiting behind Heroku
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Not needed for API
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting - 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: 'Too many requests, please try again later.' },
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

// Axios configuration with timeout
const apiRequestDefaults = {
  timeout: 30000, // 30 seconds timeout
};

const previewRequestConfig = {
  timeout: PREVIEW_TIMEOUT_MS,
  maxRedirects: 3,
  maxContentLength: PREVIEW_MAX_BYTES,
  maxBodyLength: PREVIEW_MAX_BYTES,
  responseType: 'arraybuffer',
  headers: {
    Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'User-Agent': 'pinboard-bridge/2.0 (+https://github.com/rossshannon/pinboard-bridge)'
  },
  validateStatus: status => status >= 200 && status < 400,
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
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return true;
  }

  const ipVersion = net.isIP(hostname);
  if (ipVersion === 4) {
    const octets = hostname.split('.').map(Number);
    if (octets[0] === 10) return true;
    if (octets[0] === 127) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 169 && octets[1] === 254) return true;
  }

  if (ipVersion === 6) {
    const normalized = hostname.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
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

const fetchPreview = async targetUrl => {
  const response = await axios.get(targetUrl.toString(), previewRequestConfig);
  const finalUrl = response.request?.res?.responseUrl || targetUrl.toString();
  const contentType = response.headers['content-type'] || '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new Error('Preview response is not HTML');
  }

  const body = Buffer.isBuffer(response.data)
    ? response.data.toString('utf8')
    : response.data;

  return extractPreviewMetadata(body, finalUrl, targetUrl.toString());
};

const previewRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
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

// Suggest with preview endpoint
app.get('/posts/suggest-with-preview', previewRateLimiter, async (req, res) => {
  try {
    const target = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
    if (!target) {
      return res.status(400).json({ error: 'url query parameter is required' });
    }

    let normalizedUrl;
    try {
      normalizedUrl = new URL(target);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid url parameter' });
    }

    if (!['http:', 'https:'].includes(normalizedUrl.protocol)) {
      return res.status(400).json({ error: 'URL must use http or https' });
    }

    if (isPrivateHostname(normalizedUrl.hostname)) {
      return res.status(400).json({ error: 'URL host is not reachable from the proxy' });
    }

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
    const suggestionsPromise = axios.get(pinboardUrl, authContext.requestConfig);
    const previewPromise = fetchPreview(normalizedUrl);

    const [suggestionsResult, previewResult] = await Promise.allSettled([suggestionsPromise, previewPromise]);

    if (suggestionsResult.status === 'rejected') {
      const error = suggestionsResult.reason;
      if (error.response) {
        const status = error.response.status;
        const message = typeof error.response.data === 'string'
          ? error.response.data
          : error.response.data?.error || 'API request failed';
        return res.status(status).json({ error: message });
      }

      if (error.code === 'ECONNABORTED') {
        return res.status(504).json({ error: 'Gateway timeout' });
      }

      console.error('Pinboard suggest error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }

    let preview = null;
    let previewError = null;
    let previewStatus = 'none';
    if (previewResult.status === 'fulfilled') {
      preview = previewResult.value;
      previewStatus = preview ? (preview.status || 'fresh') : 'no_data';
    } else {
      previewError = previewResult.reason?.message || 'Failed to fetch preview metadata';
      previewStatus = 'error';
    }

    const payload = {
      suggestions: suggestionsResult.value.data,
      preview,
      previewStatus
    };

    if (previewError) {
      payload.previewError = previewError;
    }

    const outcome = preview ? 'preview_generated' : (previewError ? 'preview_failed' : 'preview_not_found');
    console.info(`[preview] user=${authContext.identity} host=${normalizedUrl.hostname} outcome=${outcome}` + (previewError ? ` message="${previewError}"` : ''));

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
    const response = await axios.get(url, authContext.requestConfig);
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
