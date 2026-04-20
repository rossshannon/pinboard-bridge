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

axios.defaults.adapter = async (config) => {
  const url = config.url || '';
  if (url.includes('api.pinboard.in/v1/posts/suggest')) {
    return resolveMock(mocks.pinboard, config);
  }
  if (url === TARGET_URL) {
    return resolveMock(mocks.preview, config);
  }
  throw new Error(`Unexpected request to ${url}`);
};

process.env.PORT = '0';

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
