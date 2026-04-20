const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const TARGET_URL = 'https://example.com/article';
const PREVIEW_HTML = [
  '<html><head>',
  '<title>Test Page</title>',
  '<meta name="description" content="A test description">',
  '<meta property="og:image" content="https://example.com/og.png">',
  '</head><body></body></html>'
].join('');

// Per-test response configuration. Each test sets what Pinboard and the target
// URL should return; the mock adapter routes by URL.
const mocks = {
  pinboard: null,
  preview: null
};

const resolveMock = (spec, config) => {
  if (!spec) {
    throw new Error(`No mock configured for ${config.url}`);
  }
  if (spec.kind === 'success') {
    return {
      data: spec.data,
      status: spec.status || 200,
      statusText: 'OK',
      headers: spec.headers || { 'content-type': 'application/json' },
      config,
      request: { res: { responseUrl: spec.responseUrl || config.url } }
    };
  }
  if (spec.kind === 'network-error') {
    const err = new Error(spec.message || 'socket hang up');
    err.code = spec.code || 'ECONNRESET';
    err.config = config;
    throw err;
  }
  if (spec.kind === 'timeout') {
    const err = new Error('timeout of 30000ms exceeded');
    err.code = 'ECONNABORTED';
    err.config = config;
    throw err;
  }
  if (spec.kind === 'http-error') {
    const err = new Error(`Request failed with status code ${spec.status}`);
    err.config = config;
    err.response = {
      status: spec.status,
      statusText: spec.statusText || '',
      headers: spec.headers || {},
      data: spec.data,
      config
    };
    throw err;
  }
  throw new Error(`Unknown mock kind: ${spec.kind}`);
};

const capturedRequests = [];

const readHeader = (headers, name) => {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  // axios normalises header keys to lowercase; try both as a safety net.
  return headers[name] || headers[name.toLowerCase()];
};

axios.defaults.adapter = async (config) => {
  const url = config.url || '';
  capturedRequests.push({
    url,
    userAgent: readHeader(config.headers, 'User-Agent')
  });
  if (url.includes('api.pinboard.in/v1/posts/suggest')) {
    return resolveMock(mocks.pinboard, config);
  }
  if (url === TARGET_URL) {
    return resolveMock(mocks.preview, config);
  }
  throw new Error(`Unexpected request to ${url}`);
};

process.env.PORT = '0';
// This suite issues ~20 requests with a shared Authorization header; the
// production-safe 20/min preview limit would 429 the bulk of them.
process.env.PREVIEW_RATE_LIMIT_MAX = '10000';

const { server } = require('../web.js');

before(async () => {
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
});

after(() => {
  server.close();
});

beforeEach(() => {
  mocks.pinboard = null;
  mocks.preview = null;
  capturedRequests.length = 0;
});

const baseUrl = () => `http://127.0.0.1:${server.address().port}`;

const call = (pathAndQuery, { headers } = {}) => fetch(`${baseUrl()}${pathAndQuery}`, {
  headers: {
    'Authorization': 'Basic ' + Buffer.from('testuser:testpass').toString('base64'),
    ...(headers || {})
  }
});

const successfulPreview = () => ({
  kind: 'success',
  data: Buffer.from(PREVIEW_HTML, 'utf8'),
  headers: { 'content-type': 'text/html; charset=utf-8' },
  responseUrl: TARGET_URL
});

const previewFromHtml = (html, responseUrl = TARGET_URL) => ({
  kind: 'success',
  data: Buffer.from(html, 'utf8'),
  headers: { 'content-type': 'text/html; charset=utf-8' },
  responseUrl
});

const successfulSuggestions = () => ({
  kind: 'success',
  data: [
    { popular: ['web', 'design'] },
    { recommended: ['frontend', 'html'] }
  ],
  headers: { 'content-type': 'application/json' }
});

const requestUrl = () => `/posts/suggest-with-preview?url=${encodeURIComponent(TARGET_URL)}`;

test('happy path: returns both suggestions and preview when upstream succeeds', async () => {
  mocks.pinboard = successfulSuggestions();
  mocks.preview = successfulPreview();

  const res = await call(requestUrl());
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.suggestions, [
    { popular: ['web', 'design'] },
    { recommended: ['frontend', 'html'] }
  ]);
  assert.equal(body.suggestionsStatus, 'ok');
  assert.ok(body.preview);
  assert.equal(body.preview.title, 'Test Page');
  assert.equal(body.previewStatus, 'fresh');
  assert.equal(body.suggestionsError, undefined);
});

test('degrades to preview when Pinboard suggest drops the connection', async () => {
  mocks.pinboard = { kind: 'network-error', message: 'socket hang up', code: 'ECONNRESET' };
  mocks.preview = successfulPreview();

  const res = await call(requestUrl());
  const body = await res.json();

  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.suggestions, null);
  assert.equal(body.suggestionsStatus, 'error');
  assert.ok(body.suggestionsError, 'suggestionsError should be set');
  assert.ok(body.preview);
  assert.equal(body.preview.title, 'Test Page');
});

test('degrades when Pinboard suggest times out', async () => {
  mocks.pinboard = { kind: 'timeout' };
  mocks.preview = successfulPreview();

  const res = await call(requestUrl());
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.suggestionsStatus, 'error');
  assert.match(body.suggestionsError, /timed out|timeout/i);
  assert.ok(body.preview);
});

test('degrades when Pinboard returns 429 Too Many Requests', async () => {
  mocks.pinboard = { kind: 'http-error', status: 429, data: 'rate limited' };
  mocks.preview = successfulPreview();

  const res = await call(requestUrl());
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.suggestionsStatus, 'error');
  assert.ok(body.suggestionsError);
  assert.ok(body.preview);
});

test('passes through 401 from Pinboard (auth errors must surface)', async () => {
  mocks.pinboard = { kind: 'http-error', status: 401, data: 'Unauthorized' };
  mocks.preview = successfulPreview();

  const res = await call(requestUrl());
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.ok(body.error, 'expected error field in response body');
});

test('passes through 403 from Pinboard (auth errors must surface)', async () => {
  mocks.pinboard = { kind: 'http-error', status: 403, data: 'Forbidden' };
  mocks.preview = successfulPreview();

  const res = await call(requestUrl());

  assert.equal(res.status, 403);
});

test('returns suggestions with null preview when preview fetch fails', async () => {
  mocks.pinboard = successfulSuggestions();
  mocks.preview = { kind: 'network-error', message: 'ENOTFOUND', code: 'ENOTFOUND' };

  const res = await call(requestUrl());
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.suggestions));
  assert.equal(body.suggestionsStatus, 'ok');
  assert.equal(body.preview, null);
  assert.equal(body.previewStatus, 'error');
  assert.ok(body.previewError);
});

test('returns 401 when no Authorization header is provided', async () => {
  // Neither mock should be touched because auth check happens before upstream calls.
  const res = await fetch(`${baseUrl()}${requestUrl()}`);
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.match(body.error, /Authorization/);
});

test('returns 400 for missing url query parameter', async () => {
  const res = await call('/posts/suggest-with-preview');
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error, /url/i);
});

test('returns 400 for invalid url', async () => {
  const res = await call('/posts/suggest-with-preview?url=not-a-url');
  const body = await res.json();

  assert.equal(res.status, 400);
});

test('rejects private-network URL (SSRF guard)', async () => {
  const res = await call(`/posts/suggest-with-preview?url=${encodeURIComponent('http://127.0.0.1/x')}`);
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error, /not reachable/i);
});

// Exercising every private range the SSRF guard claims to block. The handler
// must refuse before any upstream call, so we deliberately leave the mocks
// unconfigured — if the guard slips, the adapter throws "No mock configured".
for (const host of [
  '10.0.0.1',
  '192.168.1.1',
  '172.16.5.5',
  '172.31.255.1',
  '169.254.169.254', // AWS/GCE metadata endpoint — classic SSRF target
  'localhost',
  'foo.localhost',
  '[::1]',
  '[fc00::1]',
  '[fd12:3456:789a::1]'
]) {
  test(`rejects private host ${host} without contacting upstream`, async () => {
    const res = await call(`/posts/suggest-with-preview?url=${encodeURIComponent(`http://${host}/x`)}`);
    const body = await res.json();

    assert.equal(res.status, 400, `expected 400 for ${host}, got ${res.status}`);
    assert.match(body.error, /not reachable/i);
    assert.equal(capturedRequests.length, 0, `upstream must not be called for ${host}`);
  });
}

test('allows public IPv4 addresses through the SSRF guard', async () => {
  mocks.pinboard = successfulSuggestions();
  mocks.preview = {
    kind: 'success',
    data: Buffer.from(PREVIEW_HTML, 'utf8'),
    headers: { 'content-type': 'text/html; charset=utf-8' },
    responseUrl: 'http://8.8.8.8/x'
  };

  const res = await call(`/posts/suggest-with-preview?url=${encodeURIComponent('http://8.8.8.8/x')}`);
  assert.equal(res.status, 200);
});

test('rejects preview response when upstream content-type is not HTML', async () => {
  mocks.pinboard = successfulSuggestions();
  mocks.preview = {
    kind: 'success',
    data: Buffer.from('%PDF-1.4 ...', 'utf8'),
    headers: { 'content-type': 'application/pdf' },
    responseUrl: TARGET_URL
  };

  const res = await call(requestUrl());
  const body = await res.json();

  // Suggestions still succeed; preview should cleanly fail without crashing.
  assert.equal(res.status, 200);
  assert.equal(body.suggestionsStatus, 'ok');
  assert.equal(body.preview, null);
  assert.equal(body.previewStatus, 'error');
  assert.match(body.previewError, /not HTML/i);
});

test('sends an identifying User-Agent on outbound Pinboard requests', async () => {
  mocks.pinboard = successfulSuggestions();
  mocks.preview = successfulPreview();

  const res = await call(requestUrl());
  assert.equal(res.status, 200);

  const pinboardCall = capturedRequests.find(c => c.url.includes('api.pinboard.in'));
  assert.ok(pinboardCall, 'expected an outbound call to api.pinboard.in');
  assert.ok(pinboardCall.userAgent, 'User-Agent header should be set');
  assert.match(pinboardCall.userAgent, /pinboard-bridge/i);
});

// --- Metadata precedence -----------------------------------------------------
// extractPreviewMetadata reads a cascade: twitter:* → og:* → <meta name=…> →
// <title>. These tests pin the priority order so a future refactor can't
// silently swap the winners.

const fetchPreview = async (html, { responseUrl } = {}) => {
  mocks.pinboard = successfulSuggestions();
  mocks.preview = previewFromHtml(html, responseUrl || TARGET_URL);
  const res = await call(requestUrl());
  const body = await res.json();
  assert.equal(res.status, 200);
  return body.preview;
};

test('twitter:title beats og:title beats <title>', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>Plain title</title>',
    '<meta property="og:title" content="OG title">',
    '<meta name="twitter:title" content="Twitter title">',
    '<meta property="og:image" content="https://example.com/og.png">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.title, 'Twitter title');
});

test('og:title wins when twitter:title is absent', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>Plain title</title>',
    '<meta property="og:title" content="OG title">',
    '<meta property="og:image" content="https://example.com/og.png">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.title, 'OG title');
});

test('<title> is used when no og or twitter tags are present', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>Plain title</title>',
    '<meta name="description" content="desc">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.title, 'Plain title');
});

test('description falls back from twitter to og to <meta name="description">', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>t</title>',
    '<meta name="description" content="plain desc">',
    '<meta property="og:description" content="og desc">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.description, 'og desc');
});

test('theme-color falls back to msapplication-TileColor when theme-color is absent', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>t</title>',
    '<meta name="description" content="d">',
    '<meta name="msapplication-TileColor" content="#112233">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.themeColor, '#112233');
});

test('canonical URL is taken from og:url when no <link rel="canonical">', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>t</title>',
    '<meta name="description" content="d">',
    '<meta property="og:url" content="https://example.com/canonical">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.url, 'https://example.com/canonical');
});

test('siteHandleUrl is built from twitter:site handle', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>t</title>',
    '<meta name="description" content="d">',
    '<meta name="twitter:site" content="@examplehandle">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.siteHandle, '@examplehandle');
  assert.equal(preview.siteHandleUrl, 'https://twitter.com/examplehandle');
});

// --- Favicon fallback chain --------------------------------------------------
// FAVICON_SELECTORS walks apple-touch-icon → icon[png] → icon[svg] →
// mask-icon → icon → shortcut icon. We verify the tail of the chain since the
// happy path is implicitly covered by tests that include a <link rel=icon>.

test('falls back to <link rel="shortcut icon"> when no higher-priority favicon selectors match', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>t</title>',
    '<meta name="description" content="d">',
    '<link rel="shortcut icon" href="/favicon.ico">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.faviconUrl, 'https://example.com/favicon.ico');
});

test('apple-touch-icon takes precedence over plain <link rel="icon">', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>t</title>',
    '<meta name="description" content="d">',
    '<link rel="icon" href="/fallback.ico">',
    '<link rel="apple-touch-icon" href="/apple.png">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.faviconUrl, 'https://example.com/apple.png');
});

test('faviconUrl is null when no favicon-carrying <link> is present', async () => {
  const preview = await fetchPreview([
    '<html><head>',
    '<title>t</title>',
    '<meta name="description" content="d">',
    '</head></html>'
  ].join(''));
  assert.equal(preview.faviconUrl, null);
});

// --- No-data short-circuit ---------------------------------------------------

test('returns previewStatus "no_data" when HTML has no title/description/image', async () => {
  mocks.pinboard = successfulSuggestions();
  mocks.preview = previewFromHtml('<html><head></head><body>Just body text</body></html>');

  const res = await call(requestUrl());
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.suggestionsStatus, 'ok');
  assert.equal(body.preview, null);
  assert.equal(body.previewStatus, 'no_data');
});
