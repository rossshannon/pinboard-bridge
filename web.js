const { XMLParser } = require('fast-xml-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const dns = require('dns');
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
// Read a whole-number setting. Anything else ("-1", "1e3", "300ms") falls
// back to the default with a warning, rather than being half-parsed.
const parseIntSetting = (name, fallback, { min }) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const trimmed = String(raw).trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (Number.isSafeInteger(parsed) && parsed >= min) return parsed;
  console.warn(`Ignoring ${name}=${JSON.stringify(raw)}: expected a whole number of at least ${min}. Using ${fallback}.`);
  return fallback;
};
const parseNonNegativeInt = (name, fallback) => parseIntSetting(name, fallback, { min: 0 });
const parsePositiveInt = (name, fallback) => parseIntSetting(name, fallback, { min: 1 });
// Pinboard asks for at most one API call per user every three seconds. Calls
// for the same user are spaced this far apart (start to start); set it to 0
// to turn spacing off.
const PINBOARD_MIN_INTERVAL_MS = parseNonNegativeInt('PINBOARD_MIN_INTERVAL_MS', 3000);
// Heroku's router gives up on a request after 30 s. Queueing plus the Pinboard
// call must finish inside this, leaving room to send the response.
const PINBOARD_TOTAL_BUDGET_MS = parseIntSetting('PINBOARD_TOTAL_BUDGET_MS', 25000, { min: 1000 });
// A call that would have to queue longer than this goes straight through
// instead, so a burst degrades to unspaced calls rather than piling up
// towards Heroku's 30s router timeout.
// Capped so that queueing still leaves the Pinboard call a few seconds of
// its budget.
const PINBOARD_MAX_QUEUE_LIMIT_MS = Math.max(0, PINBOARD_TOTAL_BUDGET_MS - 5000);
const PINBOARD_MAX_QUEUE_MS = (() => {
  const value = parseNonNegativeInt('PINBOARD_MAX_QUEUE_MS', 9000);
  let capped = value;
  if (value > PINBOARD_MAX_QUEUE_LIMIT_MS) {
    console.warn(`PINBOARD_MAX_QUEUE_MS=${value} would run past Heroku's router timeout. Using ${PINBOARD_MAX_QUEUE_LIMIT_MS}.`);
    capped = PINBOARD_MAX_QUEUE_LIMIT_MS;
  }
  if (PINBOARD_MIN_INTERVAL_MS > 0 && capped < PINBOARD_MIN_INTERVAL_MS) {
    console.warn(`PINBOARD_MAX_QUEUE_MS is ${capped} (PINBOARD_TOTAL_BUDGET_MS=${PINBOARD_TOTAL_BUDGET_MS} allows at most ${PINBOARD_MAX_QUEUE_LIMIT_MS}), below PINBOARD_MIN_INTERVAL_MS=${PINBOARD_MIN_INTERVAL_MS}, so no call will ever be spaced.`);
  }
  return capped;
})();
// Browsers must preflight every call to this bridge (the Authorization
// header is not CORS-safelisted). Letting them cache the preflight verdict
// saves a full round trip on repeat requests to the same URL, e.g.
// /v1/tags/get. Chrome caps this at 2h, Firefox at 24h.
const CORS_PREFLIGHT_MAX_AGE_SECONDS = 24 * 60 * 60;
// Pinboard asks clients for at most one call per user per three seconds,
// which works out at 300 per 15 minutes. Match that, rather than imposing a
// tighter ceiling that a single bookmarking session can trip.
const IP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const IP_RATE_LIMIT_MAX = parsePositiveInt('IP_RATE_LIMIT_MAX', 300);

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

// Axios configuration with timeout
const apiRequestDefaults = {
  timeout: PINBOARD_TOTAL_BUDGET_MS, // pinboardGet trims this by time spent queueing
  headers: {
    'User-Agent': USER_AGENT
  }
};

const previewRequestConfig = {
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

// Per-user spacing of Pinboard calls. Each user has a queue: a call starts
// one interval after the previous call started (or would start), or at once
// if nothing is ahead of it. Queues are keyed on the whole credential, not the
// username alone, so a request carrying someone else's username and a wrong
// token can't use up their slots.
const pinboardQueues = new Map();
let lastQueueSweepAt = 0;

const sweepPinboardQueues = now => {
  if (pinboardQueues.size <= 1000 || now - lastQueueSweepAt <= 1000) return;
  lastQueueSweepAt = now;
  for (const [key, queue] of pinboardQueues) {
    if (queue.waiting.length === 0 && queue.lastStartAt + PINBOARD_MIN_INTERVAL_MS < now) {
      pinboardQueues.delete(key);
    }
  }
};

// Work out when each waiting call starts, and (re)arm its timer.
const schedulePinboardQueue = queue => {
  let previousStart = queue.lastStartAt;
  for (const entry of queue.waiting) {
    const startAt = Math.max(Date.now(), previousStart + PINBOARD_MIN_INTERVAL_MS);
    if (startAt !== entry.startAt) {
      entry.startAt = startAt;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => startPinboardEntry(queue, entry), startAt - Date.now());
    }
    previousStart = startAt;
  }
};

const startPinboardEntry = (queue, entry) => {
  const index = queue.waiting.indexOf(entry);
  if (index === -1) return;
  queue.waiting.splice(index, 1);
  queue.lastStartAt = Date.now();
  entry.resolve();
};

// Queue a Pinboard call. `ready` resolves when it may start; `cancel` takes a
// call that hasn't started out of the queue, so the calls behind it move up.
const queuePinboardCall = slotKey => {
  const now = Date.now();
  const immediate = { ready: Promise.resolve(), cancel: () => {} };
  if (PINBOARD_MIN_INTERVAL_MS === 0) return immediate;
  sweepPinboardQueues(now);
  let queue = pinboardQueues.get(slotKey);
  if (!queue) {
    queue = { lastStartAt: -Infinity, waiting: [] };
    pinboardQueues.set(slotKey, queue);
  }
  const previousStart = queue.waiting.length
    ? queue.waiting[queue.waiting.length - 1].startAt
    : queue.lastStartAt;
  const startAt = Math.max(now, previousStart + PINBOARD_MIN_INTERVAL_MS);
  if (startAt === now) {
    queue.lastStartAt = now;
    return immediate;
  }
  if (startAt - now > PINBOARD_MAX_QUEUE_MS) {
    // Queueing this long would eat too much of the time budget: send it now.
    return immediate;
  }
  const entry = { startAt: null, timer: null, resolve: null };
  const ready = new Promise(resolve => { entry.resolve = resolve; });
  queue.waiting.push(entry);
  schedulePinboardQueue(queue);
  const cancel = () => {
    const index = queue.waiting.indexOf(entry);
    if (index === -1) return;
    queue.waiting.splice(index, 1);
    clearTimeout(entry.timer);
    entry.resolve();
    schedulePinboardQueue(queue);
  };
  return { ready, cancel };
};

// GET a Pinboard API URL on behalf of a user, spaced per user, and log how
// long it queued and how long Pinboard took. The URL is not logged: it can
// carry the auth token.
const pinboardGet = async (url, authContext, label, clientGone = null) => {
  const queuedAt = Date.now();
  const slot = queuePinboardCall(authContext.slotKey);
  // If the client leaves while this call queues, take it out of the queue
  // straight away, so the calls behind it don't wait for nothing.
  clientGone?.addEventListener('abort', slot.cancel, { once: true });
  await slot.ready;
  clientGone?.removeEventListener('abort', slot.cancel);
  const waitMs = Date.now() - queuedAt;
  const startedAt = Date.now();
  let outcome = 'ok';
  let deadlineTimer = null;
  try {
    // The browser gave up while this call queued: don't spend a Pinboard call on nobody.
    if (clientGone?.aborted) {
      const gone = new Error('Client closed the request before Pinboard was called');
      gone.code = 'ECLIENTGONE';
      throw gone;
    }
    // Time spent queueing comes out of the budget, so the whole request
    // still fits inside Heroku's router timeout.
    // waitMs never exceeds PINBOARD_MAX_QUEUE_MS, which is capped 5 s inside
    // the budget, so this is always positive.
    const timeout = PINBOARD_TOTAL_BUDGET_MS - waitMs;
    // axios's timeout only notices a stalled socket, so a response that
    // trickles in could run on; this deadline covers the whole call.
    const deadline = new AbortController();
    deadlineTimer = setTimeout(() => deadline.abort(), timeout);
    return await axios.get(url, { ...authContext.requestConfig, timeout, signal: deadline.signal });
  } catch (error) {
    if (axios.isCancel(error) || error.code === 'ERR_CANCELED') {
      // Report it the way axios reports its own timeout, which the routes map to a 504.
      error.code = 'ECONNABORTED';
      error.message = 'Pinboard call ran past its time budget';
    }
    outcome = error.response?.status ? String(error.response.status) : (error.code || 'error');
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    console.info(`[pinboard] user=${authContext.identity} call=${label} waitMs=${waitMs} upstreamMs=${Date.now() - startedAt} outcome=${outcome}`);
  }
};

// Aborts once the client disconnects before the response is sent.
const clientGoneSignal = (res) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
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

// Usernames come straight from the client's header and go into log lines, so
// keep them to characters that can't forge a line or a field.
const logSafeIdentity = value => String(value || '').replace(/[^\w.@+-]/g, '?').slice(0, 64) || 'unknown';

const applyAuthContext = (req, queryParams) => {
  if (queryParams) {
    queryParams.delete('auth_token');
  }

  const authHeader = req.get('authorization') || '';
  const slotKey = crypto.createHash('sha256').update(authHeader).digest('hex');
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
      identity: logSafeIdentity(username),
      slotKey
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
      identity: logSafeIdentity(authToken.split(':')[0] || 'token'),
      slotKey
    };
  }

  throw new Error('Authorization header required');
};

const isPrivateIPv4 = address => {
  const octets = address.split('.').map(Number);
  if (octets[0] === 0) return true; // 0.0.0.0/8 ("this host")
  if (octets[0] === 10) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true; // CGNAT
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 0 && octets[2] === 0) return true; // IETF protocol assignments
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return true; // benchmarking
  if (octets[0] >= 224) return true; // multicast, reserved and broadcast
  return false;
};

// Expand an IPv6 address to its eight 16-bit groups, or null if it isn't one.
const ipv6Groups = address => {
  let text = address;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    text = dotted[1] + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map(group => parseInt(group, 16));
  return groups.length === 8 && groups.every(group => group >= 0 && group <= 0xffff) ? groups : null;
};

const ipv4FromGroups = (high, low) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

const isPrivateIPv6 = address => {
  const groups = ipv6Groups(address);
  if (!groups) return true; // unparseable: refuse rather than guess
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const firstSixZero = groups.slice(0, 6).every(group => group === 0);
  if (firstSixZero) {
    // ::, ::1 and IPv4-compatible ::a.b.c.d
    return g6 === 0 || isPrivateIPv4(ipv4FromGroups(g6, g7));
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && (g4 === 0 || g4 === 0xffff) && (g5 === 0xffff || g5 === 0)) {
    // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d
    return isPrivateIPv4(ipv4FromGroups(g6, g7));
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    // NAT64: 64:ff9b::/96 embeds an IPv4 address; 64:ff9b:1::/48 is local use
    return g2 !== 0 || isPrivateIPv4(ipv4FromGroups(g6, g7));
  }
  if (g0 === 0x2002) return isPrivateIPv4(ipv4FromGroups(g1, g2)); // 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
};

// True for any IP address the preview fetcher must not reach.
const isPrivateAddress = address => {
  const bare = String(address || '').replace(/^\[|\]$/g, '').toLowerCase();
  const ipVersion = net.isIP(bare);
  if (ipVersion === 4) return isPrivateIPv4(bare);
  if (ipVersion === 6) return isPrivateIPv6(bare);
  return false;
};

// Tests swap `isPrivate` to let a loopback test server through; everything
// that checks an address goes through here.
const addressGuard = { isPrivate: isPrivateAddress };

const isPrivateHostname = hostname => {
  if (!hostname) return true;
  // Node's URL parser keeps IPv6 hosts wrapped in brackets (e.g. "[::1]"),
  // but net.isIP only recognises the unwrapped form. A trailing dot is the
  // same name as without it.
  const bare = hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  const lower = bare.toLowerCase();
  if (!lower || lower === 'localhost' || lower.endsWith('.localhost')) {
    return true;
  }
  return net.isIP(bare) ? addressGuard.isPrivate(bare) : false;
};

// DNS lookup for preview fetches that refuses names resolving to private
// addresses, so a public hostname pointed at 10.x or 169.254.169.254 can't
// be used to reach the dyno's network.
const guardedLookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const addresses = Array.isArray(address) ? address : [{ address, family }];
    if (addresses.some(entry => addressGuard.isPrivate(entry.address))) {
      const blocked = new Error(`Preview host ${hostname} resolves to a private address`);
      blocked.code = 'EPRIVATEADDRESS';
      return callback(blocked);
    }
    return callback(null, address, family);
  });
};

// Redirects to a literal private IP skip DNS altogether, so check each hop.
const guardRedirect = options => {
  if (isPrivateHostname(options.hostname)) {
    throw new Error('Preview redirected to a host that is not reachable from the proxy');
  }
};

// Resolve a page-supplied link, keeping only http(s): a javascript: or data:
// URL must never reach a client that renders it as a link or image.
const resolveAbsoluteUrl = (baseUrl, value) => {
  if (!value) return null;
  try {
    const resolved = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.toString() : null;
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

  const pageUrl = finalUrl || originalUrl;
  const canonicalUrl = resolveAbsoluteUrl(pageUrl, canonical) || pageUrl;
  // Relative links resolve against the page that was fetched, and the domain
  // shown is the one actually fetched: a page can name any canonical URL.
  const imageUrl = resolveAbsoluteUrl(pageUrl, rawImage);
  const siteDomain = deriveSiteDomain(pageUrl);

  const themeColor = pickMetaValue($, 'meta[name="theme-color"]')
    || pickMetaValue($, 'meta[name="msapplication-TileColor"]')
    || pickMetaValue($, 'meta[name="msapplication-navbutton-color"]');

  const rawFavicon = selectFavicon($);
  const faviconUrl = resolveAbsoluteUrl(pageUrl, rawFavicon);

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

// Finds where a page's head ends: </head> (not </header>), or the start of
// <body> for pages that leave </head> out. Text inside scripts, styles,
// titles and comments can contain either, so those are skipped, and so is
// everything inside a <template>, which can nest. Fed the page a chunk at a
// time; it remembers where it got to and keeps only the unscanned tail, so
// each byte is scanned about once.
const HEAD_TOKENS = /<\/head\s*>|<body[\s>]|<script\b|<style\b|<title\b|<template\b|<\/template\s*>|<!--(?:-?>)?/g;
const RAW_TEXT_CLOSERS = {
  '<script': /<\/script\s*>/g,
  '<style': /<\/style\s*>/g,
  '<title': /<\/title\s*>/g,
  '<!--': /-->/g
};
// Long enough to hold any token above split across two chunks.
const HEAD_SCAN_OVERLAP = 32;

const createHeadEndScanner = () => {
  let text = '';
  let pos = 0;
  let closer = null; // inside a script, style, title or comment
  let templateDepth = 0;
  return chunk => {
    text += chunk.toString('latin1').toLowerCase();
    for (;;) {
      const pattern = closer || HEAD_TOKENS;
      pattern.lastIndex = pos;
      const match = pattern.exec(text);
      if (!match) {
        // Nothing complete after pos; keep only the tail, which may hold
        // the start of a token the next chunk finishes.
        const keep = Math.max(pos, text.length - HEAD_SCAN_OVERLAP);
        text = text.slice(keep);
        pos = 0;
        return false;
      }
      pos = match.index + match[0].length;
      if (closer) {
        closer = null;
        continue;
      }
      const token = match[0].replace(/\s+$/, '');
      if (token === '<!-->' || token === '<!--->') continue; // an empty comment
      if (RAW_TEXT_CLOSERS[token]) {
        closer = RAW_TEXT_CLOSERS[token];
        continue;
      }
      if (token === '<template') {
        templateDepth += 1;
        continue;
      }
      if (token.startsWith('</template')) {
        templateDepth = Math.max(0, templateDepth - 1);
        continue;
      }
      if (templateDepth === 0) return true; // </head> or <body
    }
  };
};

// Read a streamed response until </head> (or the byte cap) and drop the rest
// of the page. Non-stream bodies (strings, buffers) are returned as they are.
const readHead = async data => {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (!data || typeof data.on !== 'function') return String(data || '');

  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const reachedHeadEnd = createHeadEndScanner();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      data.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    data.on('data', chunk => {
      chunks.push(chunk);
      length += chunk.length;
      if (reachedHeadEnd(chunk) || length >= PREVIEW_HEAD_MAX_BYTES) {
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
  let response;
  try {
    response = await axios.get(targetUrl.toString(), {
      ...previewRequestConfig,
      lookup: guardedLookup,
      beforeRedirect: guardRedirect,
      signal: controller.signal
    });
    const finalUrl = response.request?.res?.responseUrl || targetUrl.toString();
    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('Preview response is not HTML');
    }

    const body = await readHead(response.data);
    return extractPreviewMetadata(body, finalUrl, targetUrl.toString());
  } catch (error) {
    // A 4xx/5xx rejects with the unread response attached; it needs tearing
    // down just the same.
    response = response || error.response;
    if (controller.signal.aborted) {
      throw new Error(`Preview fetch timed out after ${PREVIEW_TIMEOUT_MS}ms`);
    }
    if (error.code === 'EPRIVATEADDRESS' || error.cause?.code === 'EPRIVATEADDRESS') {
      throw new Error('URL host is not reachable from the proxy');
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    // Destroying axios's stream wrapper before it is read leaves the socket
    // open, so tear down the request itself once we're done with the page.
    response?.request?.destroy?.();
    response?.data?.destroy?.();
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
// The few things a client is told about a failed preview.
const clientPreviewError = error => {
  const message = error?.message || '';
  if (/timed out/i.test(message)) return 'Preview fetch timed out';
  if (/not HTML/i.test(message)) return 'Preview response is not HTML';
  if (/not reachable from the proxy/i.test(message)) return 'URL host is not reachable from the proxy';
  if (error?.response?.status) return `Page returned HTTP ${error.response.status}`;
  return 'Could not fetch the page';
};

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
    previewError: clientPreviewError(result.reason),
    // The raw reason is for our logs only: sent to the client, a network
    // error ("connect ECONNREFUSED 10.0.0.5:6379") would let anyone probe
    // what the dyno can and can't reach.
    previewErrorDetail: JSON.stringify(String(result.reason?.message || 'unknown')),
    previewMs: result.reason?.elapsedMs ?? null
  };
};

const previewOutcome = ({ preview, previewError }) =>
  preview ? 'preview_generated' : (previewError ? 'preview_failed' : 'preview_not_found');

// Pinboard's published policy is one call per user per 3 seconds, so 20/min
// is the maximum sustained rate their /posts/suggest endpoint will accept
// before rate-limiting drops requests (observed as silent TCP hang-ups).
const PREVIEW_RATE_LIMIT_MAX = parsePositiveInt('PREVIEW_RATE_LIMIT_MAX', 20);
const suggestWithPreviewRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: PREVIEW_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many preview requests, please slow down.' },
  // Keyed on the client IP (the default). The Authorization header isn't
  // checked here, so keying on it would let a client buy a fresh allowance
  // just by changing it.
});

// /preview never calls Pinboard, so it only needs a guard against scraping.
const PAGE_PREVIEW_RATE_LIMIT_MAX = parsePositiveInt('PAGE_PREVIEW_RATE_LIMIT_MAX', 60);
const pagePreviewRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: PAGE_PREVIEW_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many preview requests, please slow down.' },
  // Keyed on the client IP (the default). The Authorization header isn't
  // checked here, so keying on it would let a client buy a fresh allowance
  // just by changing it.
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
app.get('/preview', limiter, pagePreviewRateLimiter, async (req, res) => {
  try {
    const normalizedUrl = parsePreviewTarget(req, res);
    if (!normalizedUrl) return;

    let authContext;
    try {
      authContext = applyAuthContext(req, null);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    let previewResult;
    try {
      previewResult = { status: 'fulfilled', value: await timed(fetchPreview(normalizedUrl)) };
    } catch (reason) {
      previewResult = { status: 'rejected', reason };
    }
    const { preview, previewStatus, previewError, previewErrorDetail, previewMs } = summarisePreview(previewResult);

    const payload = { preview, previewStatus };
    if (previewError) {
      payload.previewError = previewError;
    }

    console.info(`[preview] route=preview user=${authContext.identity} host=${normalizedUrl.hostname} outcome=${previewOutcome({ preview, previewError })} previewMs=${previewMs}` + (previewError ? ` previewError=${previewErrorDetail}` : ''));

    return res.json(payload);
  } catch (error) {
    console.error('Preview handler error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Suggest with preview endpoint. Kept for older clients; it answers only once
// both halves are done, so newer clients call /preview and /v1/posts/suggest
// separately.
app.get('/posts/suggest-with-preview', limiter, suggestWithPreviewRateLimiter, async (req, res) => {
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
    const suggestionsPromise = timed(pinboardGet(pinboardUrl, authContext, 'posts/suggest', clientGoneSignal(res)));
    const previewPromise = timed(fetchPreview(normalizedUrl));

    const [suggestionsResult, previewResult] = await Promise.allSettled([suggestionsPromise, previewPromise]);
    if (suggestionsResult.status === 'rejected' && suggestionsResult.reason.code === 'ECLIENTGONE') {
      return; // the client left while its call was queued
    }

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

    const { preview, previewStatus, previewError, previewErrorDetail, previewMs } = summarisePreview(previewResult);

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

    console.info(`[preview] route=suggest-with-preview user=${authContext.identity} host=${normalizedUrl.hostname} outcome=${previewOutcome({ preview, previewError })} suggestions=${suggestionsStatus} suggestMs=${suggestMs} previewMs=${previewMs}` + (previewError ? ` previewError=${previewErrorDetail}` : '') + (suggestionsError ? ` suggestionsError="${suggestionsError}"` : ''));

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
    const response = await pinboardGet(url, authContext, path.replace(/^\/v1\//, ''), clientGoneSignal(res));
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
    // The client left while its call was queued: nobody to answer.
    if (error.code === 'ECLIENTGONE') return;

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

// Read-only view of the settings in force, and how many Pinboard calls are
// queued, for tests.
const pinboardSettings = Object.freeze({
  minIntervalMs: PINBOARD_MIN_INTERVAL_MS,
  totalBudgetMs: PINBOARD_TOTAL_BUDGET_MS,
  maxQueueMs: PINBOARD_MAX_QUEUE_MS
});
const queuedPinboardCalls = () => {
  let count = 0;
  for (const queue of pinboardQueues.values()) count += queue.waiting.length;
  return count;
};

module.exports = { app, server, parseIntSetting, pinboardSettings, queuedPinboardCalls, isPrivateAddress, isPrivateHostname, guardRedirect, fetchPreview, readHead, addressGuard };
