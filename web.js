const { XMLParser } = require('fast-xml-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');
const http = require('http');
const https = require('https');
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
  // Let browser clients read the throttle state the limiters report.
  exposedHeaders: ['RateLimit-Policy', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
  maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
};

app.use(cors(corsOptions));

// Respond immediately to CORS preflight checks
app.options('*', cors(corsOptions));

// Turn any error into a JSON response: CORS rejections become 403, client
// errors Express flags itself (such as a malformed percent-encoded path) keep
// their 4xx status, and everything else is a 500. Mounted twice, here and
// after the routes, so nothing falls through to Express's HTML error page.
const jsonErrorHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed by CORS policy' });
  }
  const status = err.status || err.statusCode;
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: http.STATUS_CODES[status] || 'Bad Request' });
  }
  console.error('Unhandled error:', err.message);
  return res.status(500).json({ error: 'Internal server error' });
};

app.use(jsonErrorHandler);

// Rate limiting per IP for the generic proxy routes. This sits after cors()
// so a 429 still carries Access-Control-Allow-Origin; mounted before it, a
// browser sees a throttle as an opaque network error and can't read the
// JSON body or RateLimit-* headers. CORS preflights must never count: they
// never reach Pinboard, and counting them would halve the number of real
// requests a browser client could make. cors() already ends them above; the
// skip keeps that true if the order changes again. Requests from disallowed
// origins also stop above, with a 403, and never reach Pinboard either.
const limiter = rateLimit({
  windowMs: IP_RATE_LIMIT_WINDOW_MS,
  max: IP_RATE_LIMIT_MAX,
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: 'Too many requests, please try again later.' },
  skip: req => req.method === 'OPTIONS',
});

app.use('/v1/', limiter);

// XML parser configuration
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

const USER_AGENT = 'pinboard-bridge/2.0 (+https://github.com/rossshannon/pinboard-bridge)';

// Errors that mean the request never got an HTTP answer from Pinboard: DNS
// (including the transient EAI_AGAIN), no route, refused, or a dropped
// socket. These are reported as 503 rather than a generic 500. A socket-level
// ETIMEDOUT is a timeout like axios's own ECONNABORTED, so both get 504.
const UPSTREAM_TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);
const UPSTREAM_UNREACHABLE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

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
    const blocked = new Error('Preview redirected to a host that is not reachable from the proxy');
    blocked.code = 'EPRIVATEADDRESS';
    throw blocked;
  }
};

// True if the error, or anything it wraps, is a refusal by the guards above.
// follow-redirects and axios each wrap what guardRedirect throws, so the code
// can sit a few causes down.
const isPrivateAddressError = error => {
  for (let at = error, depth = 0; at && depth < 5; at = at.cause, depth += 1) {
    if (at.code === 'EPRIVATEADDRESS') return true;
  }
  return false;
};

// The one way the bridge fetches a URL somebody else chose (a page to
// preview, or an image that page names): http(s) only, never a private host,
// whether named outright, reached through DNS or reached by redirect.
const guardedGet = async (url, config) => {
  let target;
  try {
    target = new URL(url);
  } catch (err) {
    target = null;
  }
  if (!target || !['http:', 'https:'].includes(target.protocol) || isPrivateHostname(target.hostname)) {
    const blocked = new Error('URL host is not reachable from the proxy');
    blocked.code = 'EPRIVATEADDRESS';
    throw blocked;
  }
  return axios.get(target.toString(), {
    ...config,
    ...guardedAgents,
    maxRedirects: 3,
    lookup: guardedLookup,
    beforeRedirect: guardRedirect
  });
};

// Guarded fetches get agents of their own that never keep a connection
// alive. With the default agent, a response that has ended by the time we
// are done with it is handed back to the keep-alive pool, where destroying
// the request no longer reaches it, leaving an idle socket open to a host
// somebody else chose. The agents still connect through the `lookup` each
// request carries, so the DNS guard applies as before.
const guardedAgents = {
  httpAgent: new http.Agent({ keepAlive: false }),
  httpsAgent: new https.Agent({ keepAlive: false })
};

// Hang up on a guarded fetch that may not have finished. Destroying axios's
// stream wrapper alone leaves the socket open, so the request goes too.
const tearDownResponse = response => {
  response?.request?.destroy?.();
  response?.data?.destroy?.();
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

// The icons a page declares that a thumbnail could be made from, best first.
// selectFavicon's choice for preview.faviconUrl may be an SVG or a mask icon,
// which are never decoded, so those are left out here and the page's other
// icons get their turn. Only thumbnail requests pay for this. A page can
// declare any number of icons: the search stops at the first few usable
// ones, and looks at no more than a fixed number of links to find them.
const MAX_ICON_CANDIDATES = 3;
const MAX_ICON_LINKS_EXAMINED = 30;
const selectIconCandidates = ($, pageUrl) => {
  const found = new Set();
  let examined = 0;
  for (const selector of FAVICON_SELECTORS) {
    if (selector.includes('svg') || selector.includes('mask-icon')) continue;
    for (const element of $(selector).slice(0, MAX_ICON_LINKS_EXAMINED - examined).toArray()) {
      examined += 1;
      const type = (element.attribs.type || '').toLowerCase();
      const url = resolveAbsoluteUrl(pageUrl, (element.attribs.href || '').trim());
      if (!url || type.includes('svg') || /\.svgz?$/i.test(new URL(url).pathname)) continue;
      found.add(url);
      if (found.size >= MAX_ICON_CANDIDATES) return [...found];
    }
    if (examined >= MAX_ICON_LINKS_EXAMINED) break;
  }
  return [...found];
};

// Returns the preview (null when the page has no title, description or
// image) and, when asked, the icons a thumbnail can use, which a page may
// declare even when it has no preview.
const extractPageMetadata = (html, finalUrl, originalUrl, wantIcons) => {
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

  const iconCandidates = wantIcons ? selectIconCandidates($, pageUrl) : [];

  if (!title && !description && !imageUrl) {
    return { preview: null, iconCandidates };
  }

  const preview = {
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
  return { preview, iconCandidates };
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

// Fetch a page and read its head. Resolves to the preview, the URL the page
// was finally served from and, with `icons`, the icons it declares.
const fetchPreviewPage = async (targetUrl, { icons = false } = {}) => {
  // One deadline for the whole fetch (redirects and body included), not just
  // for each socket going quiet.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  let response;
  try {
    response = await guardedGet(targetUrl.toString(), {
      ...previewRequestConfig,
      signal: controller.signal
    });
    const finalUrl = response.request?.res?.responseUrl || targetUrl.toString();
    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      const notHtml = new Error('Preview response is not HTML');
      notHtml.code = 'ENOTHTML';
      // A success from a host we were allowed to reach: its origin can still
      // be asked for an icon.
      if (response.status < 300) notHtml.finalUrl = finalUrl;
      throw notHtml;
    }

    const body = await readHead(response.data);
    return { ...extractPageMetadata(body, finalUrl, targetUrl.toString(), icons), finalUrl };
  } catch (error) {
    // A 4xx/5xx rejects with the unread response attached; it needs tearing
    // down just the same.
    response = response || error.response;
    if (controller.signal.aborted) {
      throw new Error(`Preview fetch timed out after ${PREVIEW_TIMEOUT_MS}ms`);
    }
    if (isPrivateAddressError(error)) {
      const blocked = new Error('URL host is not reachable from the proxy');
      blocked.code = 'EPRIVATEADDRESS';
      throw blocked;
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    tearDownResponse(response);
  }
};

const fetchPreview = async targetUrl => (await fetchPreviewPage(targetUrl)).preview;

// ---- Thumbnails for /preview?thumbnails=1 ----
//
// Small copies of a page's preview image and icon, returned as data: URIs for
// clients that can't load remote images. Everything fetched here is named by
// the page, so it is treated as hostile: the fetch goes through guardedGet,
// the body is capped, only a short list of formats is decoded, and what goes
// back is always our own re-encoding, never the origin's bytes.
// Image and icon together get this long, or what is left of the request's
// whole allowance (thumbnailTuning.totalTimeoutMs) after the page fetch if
// that is less. With less than the minimum left, only the cache is consulted.
const THUMBNAIL_PHASE_TIMEOUT_MS = 4000;
const THUMBNAIL_MIN_PHASE_MS = 500;
// Requests fetching for thumbnails at once, per client (the client IP, as
// the rate limiters see it) and overall. One over either gets only what is
// already cached rather than waiting. A client showing a page of results
// asks for several at once, so its share is generous; what is scarce is
// decoding, below.
const THUMBNAIL_MAX_JOBS_PER_CLIENT = 8;
const THUMBNAIL_MAX_JOBS = 16;
// Decodes running at once. A hostile image can need its whole canvas in
// memory, so this and the limits below bound what a 512 MB dyno can be made
// to hold. Decodes beyond it wait their turn, up to the deadline.
const THUMBNAIL_MAX_DECODES = 2;
// maxPixels bounds the canvas and maxDecodedBytes its size once decoded
// (width x height x channels x bytes per sample), which is what a 16-bit
// image doubles. Measured with two decodes at once (the most the gate
// allows) of the costliest file each format permits at these limits, peak
// memory rose by about 115 MB over an idle process (interlaced PNG, 16-bit
// PNG and GIF are the worst; JPEG and WebP much less). At the earlier 16
// megapixels with no size limit, two 16-bit interlaced PNGs took 320 MB.
const THUMBNAIL_KINDS = {
  image: { maxBytes: 2 * 1024 * 1024, maxPixels: 9 * 1000 * 1000, maxDecodedBytes: 36 * 1000 * 1000, size: 240, mime: 'image/webp' },
  favicon: { maxBytes: 512 * 1024, maxPixels: 2 * 1000 * 1000, maxDecodedBytes: 8 * 1000 * 1000, size: 32, mime: 'image/png' }
};
const ICO_MAX_ENTRIES = 64;
const ICO_MAX_DIMENSION = 256;
const ICO_MAX_ATTEMPTS = 3; // entries of one .ico tried before giving up
const THUMBNAIL_CACHE_MAX_ENTRIES = 500;
const THUMBNAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const THUMBNAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// How long a URL that gave no thumbnail is left alone before it is tried
// again.
const THUMBNAIL_CACHE_RETRY_TTL_MS = 5 * 60 * 1000;
// Read on each use, so tests can shorten them. totalTimeoutMs is how long a
// thumbnail request may take from its start, page fetch included; clients
// are expected to allow a little more than this before giving up.
// decodeTimeoutSeconds is a backstop only: libvips checks it between stages
// of its work, not inside a decoder, so it can't cut a decode short. What
// bounds a decode is the byte and pixel limits: the slowest file they allow
// (a 9-megapixel progressive JPEG of 2 MB) decodes in about 0.1 s.
const thumbnailTuning = { decodeTimeoutSeconds: 3, totalTimeoutMs: 7000 };

// sharp is a native module. It is loaded on first use, not at startup, so
// that a missing or broken binary costs only the thumbnails: the proxy,
// /health and plain previews carry on without it.
const thumbnailEngine = {
  load: () => require('sharp'),
  sharp: undefined, // undefined: not tried yet; null: tried and failed
  get() {
    if (this.sharp === undefined) {
      try {
        const sharp = this.load();
        // One thread per decode and no libvips cache: thumbnails are a
        // sideline on a small dyno. Every loader is switched off except the
        // formats sniffed for below, so libvips can never be talked into
        // opening SVG, PDF, TIFF or anything else, whatever the bytes look
        // like.
        sharp.concurrency(1);
        sharp.cache(false);
        sharp.block({ operation: ['VipsForeignLoad'] });
        sharp.unblock({
          operation: [
            'VipsForeignLoadPngBuffer',
            'VipsForeignLoadJpegBuffer',
            'VipsForeignLoadNsgifBuffer',
            'VipsForeignLoadWebpBuffer'
          ]
        });
        this.sharp = sharp;
      } catch (error) {
        this.sharp = null;
        console.error(`Thumbnails are unavailable: the image library failed to load (${error.message})`);
      }
    }
    return this.sharp;
  }
};

const thumbnailRequestConfig = {
  responseType: 'stream',
  headers: {
    Accept: 'image/webp,image/png,image/jpeg,image/gif,image/x-icon;q=0.9,*/*;q=0.5',
    'User-Agent': USER_AGENT
  },
  validateStatus: status => status >= 200 && status < 300,
};

// A thumbnail that can't be made. `outcome` is a short word for the logs:
//   settled (the same again next time): blocked, too_large, unsupported,
//     undecodable, http_404 and other 4xx
//   transient (worth another try): timeout, decode_timeout, error, http_5xx,
//     http_429, http_408
// and, for a whole request: none (nothing to fetch), no_page, busy,
// unavailable.
const thumbnailError = outcome => {
  const error = new Error(`Thumbnail failed: ${outcome}`);
  error.outcome = outcome;
  return error;
};

const thumbnailOutcome = (error, signal) => {
  if (error?.outcome) return error.outcome;
  if (signal.aborted) return 'timeout';
  if (isPrivateAddressError(error)) return 'blocked';
  if (error?.response?.status) return `http_${error.response.status}`;
  return 'error';
};

const isTransientOutcome = outcome =>
  ['timeout', 'decode_timeout', 'error', 'http_408', 'http_429'].includes(outcome) || /^http_5/.test(outcome);

// Read a response body into memory, giving up the moment it passes maxBytes
// or the signal fires.
const readCapped = (stream, maxBytes, signal) => new Promise((resolve, reject) => {
  const chunks = [];
  let length = 0;
  let settled = false;
  const settle = (fn, value) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    fn(value);
  };
  const fail = error => {
    stream.destroy();
    settle(reject, error);
  };
  const onAbort = () => fail(thumbnailError('timeout'));
  if (signal.aborted) return onAbort();
  signal.addEventListener('abort', onAbort);
  stream.on('data', chunk => {
    length += chunk.length;
    if (length > maxBytes) return fail(thumbnailError('too_large'));
    chunks.push(chunk);
  });
  stream.on('end', () => settle(resolve, Buffer.concat(chunks)));
  stream.on('error', error => settle(reject, error));
  stream.on('close', () => settle(reject, thumbnailError('error')));
});

// Fetch an image the page named, through the same guards as the page itself.
const fetchImageBytes = async (url, maxBytes, signal) => {
  let response;
  try {
    response = await guardedGet(url, { ...thumbnailRequestConfig, signal });
    if (Number(response.headers['content-length']) > maxBytes) {
      throw thumbnailError('too_large');
    }
    return await readCapped(response.data, maxBytes, signal);
  } catch (error) {
    response = response || error.response;
    throw error;
  } finally {
    tearDownResponse(response);
  }
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const startsWith = (buffer, bytes, offset = 0) =>
  buffer.length >= offset + bytes.length && buffer.compare(bytes, 0, bytes.length, offset, offset + bytes.length) === 0;

// Decide what a file is from its first bytes; the Content-Type header and the
// URL's extension are the origin's say-so and count for nothing. Anything not
// listed is null: SVG and HTML, and also AVIF and HEIF, whose decoder can be
// made to hold hundreds of megabytes by a file of a few hundred bytes.
const sniffImageFormat = buffer => {
  if (startsWith(buffer, PNG_MAGIC)) return 'png';
  if (startsWith(buffer, Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  if (startsWith(buffer, Buffer.from('GIF87a')) || startsWith(buffer, Buffer.from('GIF89a'))) return 'gif';
  if (startsWith(buffer, Buffer.from('RIFF')) && startsWith(buffer, Buffer.from('WEBP'), 8)) return 'webp';
  if (startsWith(buffer, Buffer.from([0, 0, 1, 0]))) return 'ico';
  return null;
};
// What sharp calls each format once it has opened it.
const SHARP_FORMAT_NAMES = { png: 'png', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };

// Decode one ICO entry stored as a bitmap: an uncompressed DIB (1-, 4- or
// 8-bit with a colour table, or 24- or 32-bit) followed by a 1-bit
// transparency mask. Returns raw RGBA, or null for anything else
// (compression, other depths, sizes that don't fit the data).
const decodeIcoBitmap = data => {
  if (data.length < 40) return null;
  const headerSize = data.readUInt32LE(0);
  const width = data.readInt32LE(4);
  const height = data.readInt32LE(8) / 2; // stored doubled, to cover the mask
  const bitCount = data.readUInt16LE(14);
  const compression = data.readUInt32LE(16);
  if (headerSize < 40 || headerSize > data.length) return null;
  if (compression !== 0 || ![1, 4, 8, 24, 32].includes(bitCount)) return null;
  if (!Number.isInteger(height) || width < 1 || height < 1 || width > ICO_MAX_DIMENSION || height > ICO_MAX_DIMENSION) {
    return null;
  }
  // Palette depths: a table of BGRx colours sits between header and pixels.
  let paletteSize = 0;
  if (bitCount <= 8) {
    paletteSize = data.readUInt32LE(32) || (1 << bitCount); // 0 means the full table
    if (paletteSize > (1 << bitCount)) return null;
  }
  const paletteAt = headerSize;
  const pixelsAt = paletteAt + paletteSize * 4;
  const stride = Math.ceil((width * bitCount) / 32) * 4;
  const maskAt = pixelsAt + stride * height;
  if (maskAt > data.length) return null;
  const maskStride = Math.ceil(width / 32) * 4;
  const hasMask = maskAt + maskStride * height <= data.length;

  const rgba = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y += 1) {
    const row = pixelsAt + (height - 1 - y) * stride; // rows are stored bottom-up
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4;
      let from;
      if (bitCount <= 8) {
        // Pixels are packed most significant bits first.
        const perByte = 8 / bitCount;
        const shift = (perByte - 1 - (x % perByte)) * bitCount;
        const index = (data[row + Math.floor(x / perByte)] >> shift) & ((1 << bitCount) - 1);
        if (index >= paletteSize) continue; // no such colour: left black
        from = paletteAt + index * 4;
      } else {
        from = row + x * (bitCount / 8);
      }
      rgba[to] = data[from + 2];
      rgba[to + 1] = data[from + 1];
      rgba[to + 2] = data[from];
      rgba[to + 3] = bitCount === 32 ? data[from + 3] : 255;
      if (bitCount === 32 && data[from + 3] !== 0) anyAlpha = true;
    }
  }
  // Everything but a 32-bit entry with a real alpha channel takes its
  // transparency from the mask (a set bit is transparent).
  if (!anyAlpha) {
    for (let y = 0; y < height; y += 1) {
      const row = maskAt + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x += 1) {
        const masked = hasMask && (data[row + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
        rgba[(y * width + x) * 4 + 3] = masked ? 0 : 255;
      }
    }
  }
  return { rgba, width, height };
};

// List the entries of an .ico file worth trying for targetSize, best first:
// the smallest one at least that big, then larger ones, then the biggest of
// the smaller ones. Each is { png } for an embedded PNG (still to be
// decoded) or { raw } for a decoded bitmap; at most ICO_MAX_ATTEMPTS are
// returned. Every offset and size in the file is checked against the buffer
// before it is used.
const pickIcoImages = (buffer, targetSize) => {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return [];
  const count = buffer.readUInt16LE(4);
  const directoryEnd = 6 + 16 * count;
  if (count < 1 || count > ICO_MAX_ENTRIES || directoryEnd > buffer.length) return [];

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + 16 * i;
    const size = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    if (size < 1 || offset < directoryEnd || offset + size > buffer.length) continue;
    entries.push({
      extent: Math.min(buffer[at] || 256, buffer[at + 1] || 256), // 0 means 256
      bitCount: buffer.readUInt16LE(at + 6),
      data: buffer.subarray(offset, offset + size)
    });
  }
  const rank = entry => (entry.extent >= targetSize ? entry.extent : 2 * ICO_MAX_DIMENSION - entry.extent);
  entries.sort((a, b) => rank(a) - rank(b) || b.bitCount - a.bitCount);

  const images = [];
  for (const entry of entries) {
    if (images.length >= ICO_MAX_ATTEMPTS) break;
    if (startsWith(entry.data, PNG_MAGIC)) {
      images.push({ png: entry.data });
    } else {
      const raw = decodeIcoBitmap(entry.data);
      if (raw) images.push({ raw });
    }
  }
  return images;
};

// Turns at decoding, shared fairly between clients. At most `max` run at
// once. A freed turn goes to the waiting client that holds fewest and, among
// those, the one that has gone longest without one, so one client's backlog
// can't keep both turns while anyone else is waiting. A wait ends early, with
// decode_timeout, if its signal fires.
const createFairGate = max => {
  const gate = { active: 0, held: new Map(), queues: new Map(), lastTurn: new Map(), turns: 0 };
  const grant = client => {
    gate.active += 1;
    gate.turns += 1;
    gate.held.set(client, (gate.held.get(client) || 0) + 1);
    gate.lastTurn.set(client, gate.turns);
  };
  const before = (a, b) => {
    const heldA = gate.held.get(a) || 0;
    const heldB = gate.held.get(b) || 0;
    return heldA !== heldB ? heldA < heldB : (gate.lastTurn.get(a) || 0) < (gate.lastTurn.get(b) || 0);
  };
  const release = client => {
    gate.active -= 1;
    const mine = gate.held.get(client) - 1;
    if (mine > 0) gate.held.set(client, mine); else gate.held.delete(client);
    let next = null;
    for (const waiting of gate.queues.keys()) {
      if (next === null || before(waiting, next)) next = waiting;
    }
    if (next !== null) {
      const queue = gate.queues.get(next);
      const entry = queue.shift();
      if (queue.length === 0) gate.queues.delete(next);
      grant(next);
      entry.start();
    }
    // A client with nothing running or waiting is forgotten.
    if (!gate.held.has(client) && !gate.queues.has(client)) gate.lastTurn.delete(client);
  };
  gate.run = async (client, signal, fn) => {
    if (gate.active < max) {
      grant(client);
    } else {
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(thumbnailError('decode_timeout'));
        const entry = {};
        const onAbort = () => {
          const queue = gate.queues.get(client);
          queue.splice(queue.indexOf(entry), 1);
          if (queue.length === 0) gate.queues.delete(client);
          if (!gate.held.has(client) && !gate.queues.has(client)) gate.lastTurn.delete(client);
          reject(thumbnailError('decode_timeout'));
        };
        entry.start = () => {
          signal.removeEventListener('abort', onAbort);
          resolve(); // woken holding a turn
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (!gate.queues.has(client)) gate.queues.set(client, []);
        gate.queues.get(client).push(entry);
      });
    }
    try {
      return await fn();
    } finally {
      release(client);
    }
  };
  return gate;
};
const thumbnailDecodeGate = createFairGate(THUMBNAIL_MAX_DECODES);

// Decode one input with sharp and re-encode it as the thumbnail for `kind`.
const encodeThumbnail = async (sharp, kind, input) => {
  const spec = THUMBNAIL_KINDS[kind];
  // Animated files give their first frame only (pages: 1).
  const options = { limitInputPixels: spec.maxPixels, failOn: 'error', sequentialRead: true, pages: 1, raw: input.raw };
  try {
    if (!input.raw) {
      // Reading the header decodes nothing, so it is done without sharp's own
      // pixel limit and the limits are applied here, where they can be told
      // apart from a broken file.
      const metadata = await sharp(input.bytes, { ...options, limitInputPixels: false }).metadata();
      // The loader libvips chose must be the one the first bytes promised.
      if (metadata.format !== SHARP_FORMAT_NAMES[input.format]) throw thumbnailError('unsupported');
      // Refuse from the header anything that would decode to too much: by
      // area, and by size in memory, which a 16-bit image doubles.
      const sampleBytes = { uchar: 1, char: 1, ushort: 2, short: 2 }[metadata.depth] || 4;
      const pixels = metadata.width * metadata.height;
      if (!(pixels <= spec.maxPixels) || !(pixels * metadata.channels * sampleBytes <= spec.maxDecodedBytes)) {
        throw thumbnailError('too_large');
      }
    }
    // Nothing of the original's metadata is carried over: sharp drops EXIF,
    // ICC and the rest unless asked to keep them.
    const resized = sharp(input.bytes, options)
      .rotate() // apply the EXIF orientation that is about to be dropped
      .resize({ width: spec.size, height: spec.size, fit: 'inside', withoutEnlargement: true })
      .timeout({ seconds: thumbnailTuning.decodeTimeoutSeconds });
    const encoded = kind === 'image' ? resized.webp({ quality: 70 }) : resized.png();
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    return { dataUri: `data:${spec.mime};base64,${data.toString('base64')}`, width: info.width, height: info.height };
  } catch (error) {
    if (error.outcome) throw error;
    // sharp reports its own time limit as "timeout: 52% complete". That says
    // the dyno was slow or the image heavy, not that the image is bad.
    throw thumbnailError(/\btimeout: \d+% complete/.test(error.message || '') ? 'decode_timeout' : 'undecodable');
  }
};

// Turn fetched bytes into a thumbnail: { dataUri, width, height }. `client`
// is whose turn at decoding this takes.
const renderThumbnail = async (sharp, kind, bytes, client, signal) => {
  const format = sniffImageFormat(bytes);
  let inputs;
  if (format === 'ico') {
    // An .ico is an icon, never a preview image. Its entries are tried in
    // turn, so one bad embedded PNG doesn't cost the whole file.
    const picked = kind === 'favicon' ? pickIcoImages(bytes, THUMBNAIL_KINDS[kind].size) : [];
    inputs = picked.map(image => (image.png
      ? { bytes: image.png, format: 'png' }
      : { bytes: image.raw.rgba, raw: { width: image.raw.width, height: image.raw.height, channels: 4 } }));
  } else {
    inputs = format ? [{ bytes, format }] : [];
  }
  if (inputs.length === 0) throw thumbnailError('unsupported');

  return thumbnailDecodeGate.run(client, signal, async () => {
    let failure;
    for (const input of inputs) {
      // An earlier entry may have used up the time.
      if (signal.aborted) throw thumbnailError('decode_timeout');
      try {
        return await encodeThumbnail(sharp, kind, input);
      } catch (error) {
        failure = error;
        if (error.outcome !== 'undecodable' && error.outcome !== 'unsupported') break;
      }
    }
    throw failure;
  });
};

// Rendered thumbnails by kind and image URL, most recently used last, so an
// icon or default image shared by a whole site is fetched and decoded once.
// URLs that gave no thumbnail are remembered too, briefly. Bounded by entry
// count and by total size; entries past their time are dropped when next
// asked for.
const thumbnailCache = {
  entries: new Map(),
  bytes: 0,
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.delete(key);
    if (entry.expiresAt <= Date.now()) return null;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    return entry.value;
  },
  set(key, value, ttlMs) {
    this.delete(key);
    const bytes = Buffer.byteLength(key) + (value.thumbnail ? value.thumbnail.dataUri.length : 0) + 64;
    if (bytes > THUMBNAIL_CACHE_MAX_BYTES) return;
    this.entries.set(key, { value, bytes, expiresAt: Date.now() + ttlMs });
    this.bytes += bytes;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= THUMBNAIL_CACHE_MAX_ENTRIES && this.bytes <= THUMBNAIL_CACHE_MAX_BYTES) break;
      this.delete(oldest);
    }
  },
  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  },
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
};

// Image fetches and thumbnails in the making, so that requests wanting the
// same thing at the same moment (several pages of one site, each naming the
// site's icon) share one fetch and one decode. Each piece of work has a
// deadline of its own rather than its first requester's: a request that runs
// out of time leaves it to finish for the cache and for anyone else waiting.
// Entries always clear themselves, and every waiter gets the outcome.
const imageFetchesInFlight = new Map(); // "maxBytes url" -> promise of the bytes
const thumbnailsInFlight = new Map(); // "kind url", as in the cache -> promise of { thumbnail, outcome }

const sharedImageFetch = (url, maxBytes) => {
  const key = `${maxBytes} ${url}`;
  let pending = imageFetchesInFlight.get(key);
  if (!pending) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), THUMBNAIL_PHASE_TIMEOUT_MS);
    pending = fetchImageBytes(url, maxBytes, controller.signal)
      .catch(error => {
        // Settle on the outcome here, while the signal can still tell a
        // timeout from any other failure.
        throw thumbnailError(thumbnailOutcome(error, controller.signal));
      })
      .finally(() => {
        clearTimeout(deadline);
        imageFetchesInFlight.delete(key);
      });
    imageFetchesInFlight.set(key, pending);
  }
  return pending;
};

// Fetch and render one thumbnail and record the answer. Never rejects.
const makeThumbnail = async (sharp, kind, url, fetchMaxBytes, client) => {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), THUMBNAIL_PHASE_TIMEOUT_MS);
  let result;
  try {
    const bytes = await sharedImageFetch(url, fetchMaxBytes);
    // The fetch may have been made under the image's larger cap.
    if (bytes.length > THUMBNAIL_KINDS[kind].maxBytes) throw thumbnailError('too_large');
    result = { thumbnail: await renderThumbnail(sharp, kind, bytes, client, controller.signal), outcome: 'ok' };
  } catch (error) {
    result = { thumbnail: null, outcome: thumbnailOutcome(error, controller.signal) };
  } finally {
    clearTimeout(deadline);
  }
  // A decode that ran out of time says more about us than about the image,
  // so it isn't held against the URL.
  if (result.outcome !== 'decode_timeout') {
    thumbnailCache.set(`${kind} ${url}`, result, result.thumbnail ? THUMBNAIL_CACHE_TTL_MS : THUMBNAIL_CACHE_RETRY_TTL_MS);
  }
  return result;
};

// Join the making of a thumbnail, or start it. `started` says which.
const sharedThumbnail = (sharp, kind, url, fetchMaxBytes, client) => {
  const key = `${kind} ${url}`;
  let pending = thumbnailsInFlight.get(key);
  if (pending) return { pending, started: false };
  pending = makeThumbnail(sharp, kind, url, fetchMaxBytes, client)
    .catch(() => ({ thumbnail: null, outcome: 'error' }))
    .finally(() => thumbnailsInFlight.delete(key));
  thumbnailsInFlight.set(key, pending);
  return { pending, started: true };
};

const noThumbnail = (outcome, ms = 0) =>
  ({ thumbnail: null, outcome, source: null, cached: false, transient: isTransientOutcome(outcome), ms });

// Answer for one kind from the cache alone: the thumbnail of the first
// candidate that has one, or the last failure if every candidate is known to
// have failed. Null if a candidate would have to be fetched to know.
const settleFromCache = (kind, candidates) => {
  let outcome = 'none'; // nothing to fetch
  let transient = false;
  for (const { source, url } of candidates) {
    const result = thumbnailCache.get(`${kind} ${url}`);
    if (!result) return null;
    if (result.thumbnail) {
      return { thumbnail: result.thumbnail, outcome: 'ok', source, cached: true, transient: false, ms: 0 };
    }
    outcome = result.outcome;
    transient = transient || isTransientOutcome(outcome);
  }
  return { thumbnail: null, outcome, source: null, cached: candidates.length > 0, transient, ms: 0 };
};

// Try each candidate URL in turn until one makes a thumbnail. `job` carries
// what the request's two kinds share. Never rejects.
const settleThumbnail = async (kind, candidates, job) => {
  const startedAt = Date.now();
  let outcome = 'none';
  let transient = false;
  let cached = false;
  for (const { source, url } of candidates) {
    let result = thumbnailCache.get(`${kind} ${url}`);
    cached = Boolean(result);
    if (!result) {
      // A URL wanted as both image and icon is fetched once, under the
      // image's cap; the icon then applies its own smaller cap to the bytes.
      const fetchMaxBytes = (url === job.imageUrl ? THUMBNAIL_KINDS.image : THUMBNAIL_KINDS.favicon).maxBytes;
      const { pending, started } = sharedThumbnail(job.sharp, kind, url, fetchMaxBytes, job.client);
      if (started) job.started.push(pending);
      result = await Promise.race([pending, job.expired]);
    }
    if (result.thumbnail) {
      return { thumbnail: result.thumbnail, outcome: 'ok', source, cached, transient: false, ms: Date.now() - startedAt };
    }
    outcome = result.outcome;
    transient = transient || isTransientOutcome(outcome);
    if (job.signal.aborted) break;
  }
  return { thumbnail: null, outcome, source: null, cached, transient, ms: Date.now() - startedAt };
};

// Places for requests that are fetching images, counted per client and
// overall.
const thumbnailJobs = {
  active: 0,
  perClient: new Map(),
  acquire(client) {
    const mine = this.perClient.get(client) || 0;
    if (this.active >= THUMBNAIL_MAX_JOBS || mine >= THUMBNAIL_MAX_JOBS_PER_CLIENT) return false;
    this.active += 1;
    this.perClient.set(client, mine + 1);
    return true;
  },
  release(client) {
    const mine = this.perClient.get(client) || 0;
    this.active -= 1;
    if (mine <= 1) this.perClient.delete(client); else this.perClient.set(client, mine - 1);
  }
};

// Build both thumbnails for a page, in parallel, within budgetMs. Resolves
// to { image, favicon }, each as settleThumbnail returns; never rejects.
const buildThumbnails = async (page, sharp, client, budgetMs) => {
  const imageUrl = page.preview?.imageUrl || null;
  const imageCandidates = imageUrl ? [{ source: 'declared', url: imageUrl }] : [];
  // The page's own raster icons first, then /favicon.ico on the origin the
  // page was finally served from.
  const faviconCandidates = page.iconCandidates.map(url => ({ source: 'declared', url }));
  const fallbackIcon = resolveAbsoluteUrl(page.finalUrl, '/favicon.ico');
  if (fallbackIcon && !page.iconCandidates.includes(fallbackIcon)) {
    faviconCandidates.push({ source: 'fallback', url: fallbackIcon });
  }

  // What the cache already knows costs nothing, so it is looked at before
  // deciding whether there is time or room to do more.
  const known = {
    image: settleFromCache('image', imageCandidates),
    favicon: settleFromCache('favicon', faviconCandidates)
  };
  if (known.image && known.favicon) return known;
  const knownOr = outcome => ({ image: known.image || noThumbnail(outcome), favicon: known.favicon || noThumbnail(outcome) });
  if (budgetMs < THUMBNAIL_MIN_PHASE_MS) return knownOr('timeout');
  if (!thumbnailJobs.acquire(client)) return knownOr('busy');

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), budgetMs);
  const job = {
    sharp,
    client,
    imageUrl,
    signal: controller.signal,
    expired: new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve({ thumbnail: null, outcome: 'timeout' }), { once: true });
    }),
    started: [] // the work this request set going, which may outlast it
  };
  const tasks = [
    known.image || settleThumbnail('image', imageCandidates, job),
    known.favicon || settleThumbnail('favicon', faviconCandidates, job)
  ].map(task => Promise.resolve(task).catch(() => noThumbnail('error')));
  const [image, favicon] = await Promise.all(tasks);
  clearTimeout(deadline);
  // The request's place is given back only once the work it started has
  // really ended, so the places bound the fetches and decodes in flight even
  // when answers go out at a deadline.
  Promise.all(job.started).then(() => thumbnailJobs.release(client));
  return { image, favicon };
};

// A failed page fetch that might go differently next time: a timeout, a
// network error, or a status that says "later". A refused host, a 404 or a
// response that isn't HTML will be the same again.
const isTransientPageFailure = error => {
  if (isPrivateAddressError(error) || error?.code === 'ENOTHTML') return false;
  const status = error?.response?.status;
  if (status) return status >= 500 || status === 429 || status === 408;
  return true;
};

// The thumbnail fields of a response, and their part of the log line.
// thumbnailsStatus tells a client how far to trust a null:
//   complete     every answer is settled; safe to keep
//   transient    something timed out or failed in passing; worth asking again
//   busy         too many thumbnail requests in flight; only what was
//                already cached is given
//   unavailable  this bridge can't make thumbnails at all
const thumbnailFields = async (page, pageError, client, requestStartedAt) => {
  const sharp = thumbnailEngine.get();
  let source = page;
  if (!source && pageError?.code === 'ENOTHTML' && pageError.finalUrl) {
    // A PDF or a bare image has no head to read, but its site has an icon.
    source = { preview: null, iconCandidates: [], finalUrl: pageError.finalUrl };
  }
  let image;
  let favicon;
  let status;
  if (!sharp) {
    image = favicon = noThumbnail('unavailable');
    status = 'unavailable';
  } else if (!source) {
    // Nothing more is fetched for a page that failed or was refused.
    image = favicon = noThumbnail('no_page');
    status = isTransientPageFailure(pageError) ? 'transient' : 'complete';
  } else {
    const remaining = thumbnailTuning.totalTimeoutMs - (Date.now() - requestStartedAt);
    ({ image, favicon } = await buildThumbnails(source, sharp, client, Math.min(THUMBNAIL_PHASE_TIMEOUT_MS, remaining)));
    if (image.outcome === 'busy' || favicon.outcome === 'busy') status = 'busy';
    else status = image.transient || favicon.transient ? 'transient' : 'complete';
  }
  const logPart = (name, result) => ` ${name}=${result.outcome}`
    + (result.source ? ` ${name}Source=${result.source}` : '')
    + ` ${name}Ms=${result.ms}` + (result.cached ? ` ${name}Cache=hit` : '');
  return {
    thumbnails: { image: image.thumbnail, favicon: favicon.thumbnail },
    thumbnailsStatus: status,
    log: ` thumbs=${status}` + logPart('image', image) + logPart('favicon', favicon)
  };
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

// Fetch a page for /preview and work out the response and the log line's
// fields. With a thumbnailClient (the caller's IP), thumbnails are added.
const previewAnswer = async (targetUrl, thumbnailClient) => {
  const requestStartedAt = Date.now();
  const wantThumbnails = thumbnailClient !== null;
  let page = null;
  let pageError = null;
  let previewResult;
  try {
    const fetched = await timed(fetchPreviewPage(targetUrl, { icons: wantThumbnails }));
    page = fetched.value;
    previewResult = { status: 'fulfilled', value: { value: page.preview, ms: fetched.ms } };
  } catch (reason) {
    pageError = reason;
    previewResult = { status: 'rejected', reason };
  }
  const { preview, previewStatus, previewError, previewErrorDetail, previewMs } = summarisePreview(previewResult);

  const payload = { preview, previewStatus };
  if (previewError) {
    payload.previewError = previewError;
  }
  let log = `outcome=${previewOutcome({ preview, previewError })} previewMs=${previewMs}` + (previewError ? ` previewError=${previewErrorDetail}` : '');

  if (wantThumbnails) {
    const fields = await thumbnailFields(page, pageError, thumbnailClient, requestStartedAt);
    payload.thumbnails = fields.thumbnails;
    payload.thumbnailsStatus = fields.thumbnailsStatus;
    log += fields.log;
  }
  return { payload, log };
};

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

    // thumbnails=1 adds small data: URI copies of the page's image and icon.
    // Any other value, or none, leaves the response exactly as it was.
    const answer = await previewAnswer(normalizedUrl, req.query.thumbnails === '1' ? (req.ip || 'unknown') : null);

    console.info(`[preview] route=preview user=${authContext.identity} host=${normalizedUrl.hostname} ${answer.log}`);

    return res.json(answer.payload);
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
      } else if (UPSTREAM_TIMEOUT_CODES.has(error.code)) {
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
    if (UPSTREAM_TIMEOUT_CODES.has(error.code)) {
      console.error('Request timeout:', error.message);
      return res.status(504).json({ error: 'Gateway timeout' });
    }

    // Handle network-layer errors (DNS failure, connection refused, reset)
    if (UPSTREAM_UNREACHABLE_CODES.has(error.code)) {
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

// The same handler again, for errors raised after the first mount: the rate
// limiter's store, routing (a malformed path), or a route itself.
app.use(jsonErrorHandler);

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

module.exports = { app, server, parseIntSetting, jsonErrorHandler, pinboardSettings, queuedPinboardCalls, isPrivateAddress, isPrivateHostname, guardRedirect, fetchPreview, readHead, addressGuard };

// The thumbnail internals, for tests.
module.exports.thumbnailing = {
  cache: thumbnailCache,
  jobs: thumbnailJobs,
  engine: thumbnailEngine,
  tuning: thumbnailTuning,
  inFlight: thumbnailsInFlight,
  fetchesInFlight: imageFetchesInFlight,
  decodeGate: thumbnailDecodeGate,
  sniffImageFormat,
  pickIcoImages,
  settings: Object.freeze({
    phaseTimeoutMs: THUMBNAIL_PHASE_TIMEOUT_MS,
    minPhaseMs: THUMBNAIL_MIN_PHASE_MS,
    maxJobs: THUMBNAIL_MAX_JOBS,
    maxJobsPerClient: THUMBNAIL_MAX_JOBS_PER_CLIENT,
    maxDecodes: THUMBNAIL_MAX_DECODES,
    cacheMaxEntries: THUMBNAIL_CACHE_MAX_ENTRIES,
    cacheMaxBytes: THUMBNAIL_CACHE_MAX_BYTES,
    cacheTtlMs: THUMBNAIL_CACHE_TTL_MS,
    cacheRetryTtlMs: THUMBNAIL_CACHE_RETRY_TTL_MS,
    kinds: THUMBNAIL_KINDS
  })
};
