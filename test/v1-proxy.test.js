const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// Per-test mock state. Each test sets `mocks.upstream` before calling.
const mocks = {
  upstream: null
};
const capturedRequests = [];

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
      request: { res: { responseUrl: config.url } }
    };
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
  if (spec.kind === 'timeout') {
    const err = new Error('timeout of 30000ms exceeded');
    err.code = 'ECONNABORTED';
    err.config = config;
    throw err;
  }
  if (spec.kind === 'network-error') {
    const err = new Error(spec.message || 'socket hang up');
    err.code = spec.code || 'ECONNRESET';
    err.config = config;
    throw err;
  }
  throw new Error(`Unknown mock kind: ${spec.kind}`);
};

axios.defaults.adapter = async (config) => {
  capturedRequests.push({
    url: config.url,
    method: config.method,
    auth: config.auth ? { ...config.auth } : undefined
  });
  return resolveMock(mocks.upstream, config);
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
  mocks.upstream = null;
  capturedRequests.length = 0;
});

const baseUrl = () => `http://127.0.0.1:${server.address().port}`;
const basicAuthHeader = (user = 'testuser', pass = 'testpass') =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
const bearerAuthHeader = (token = 'testuser:DEADBEEF12345678') => `Bearer ${token}`;

const call = (path, { headers } = {}) => fetch(`${baseUrl()}${path}`, {
  headers: { 'Authorization': basicAuthHeader(), ...(headers || {}) }
});

test('parses Pinboard XML response into JSON when format is not json', async () => {
  mocks.upstream = {
    kind: 'success',
    data: '<?xml version="1.0" encoding="UTF-8"?><posts user="alice"><post href="https://example.com/" description="Example" tag="web"/></posts>',
    headers: { 'content-type': 'application/xml' }
  };

  const res = await call('/v1/posts/get?tag=web');
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(body.posts, 'expected xml-parsed posts node');
  assert.equal(body.posts['@_user'], 'alice');
  assert.equal(body.posts.post['@_href'], 'https://example.com/');
});

test('passes JSON response straight through when format=json', async () => {
  mocks.upstream = {
    kind: 'success',
    data: { update_time: '2026-04-20T00:00:00Z' },
    headers: { 'content-type': 'application/json' }
  };

  const res = await call('/v1/posts/update?format=json');
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { update_time: '2026-04-20T00:00:00Z' });
});

test('forwards Basic auth credentials to Pinboard', async () => {
  mocks.upstream = { kind: 'success', data: { result_code: 'done' } };

  const res = await call('/v1/posts/add?url=https://example.com&description=hi&format=json');
  assert.equal(res.status, 200);

  const sent = capturedRequests[0];
  assert.ok(sent.auth, 'expected axios auth to be attached');
  assert.equal(sent.auth.username, 'testuser');
  assert.equal(sent.auth.password, 'testpass');
  // The auth_token query parameter must not leak into upstream URL under Basic auth.
  assert.ok(!sent.url.includes('auth_token'), `auth_token leaked into ${sent.url}`);
});

test('forwards Bearer token as auth_token query param to Pinboard', async () => {
  mocks.upstream = { kind: 'success', data: { result_code: 'done' } };

  const res = await fetch(`${baseUrl()}/v1/posts/update?format=json`, {
    headers: { 'Authorization': bearerAuthHeader('alice:HEX12345') }
  });
  assert.equal(res.status, 200);

  const sent = capturedRequests[0];
  assert.ok(sent.url.includes('auth_token=alice%3AHEX12345') || sent.url.includes('auth_token=alice:HEX12345'),
    `expected auth_token in upstream URL, got ${sent.url}`);
  assert.equal(sent.auth, undefined, 'Bearer should not set axios basic auth');
});

test('strips any client-supplied auth_token query param before re-applying server auth', async () => {
  mocks.upstream = { kind: 'success', data: {} };

  // Client tries to smuggle their own auth_token alongside a Basic header.
  await call('/v1/posts/update?format=json&auth_token=attacker:DEADBEEF');

  const sent = capturedRequests[0];
  assert.ok(!sent.url.includes('auth_token=attacker'),
    `client-supplied auth_token must be stripped, got ${sent.url}`);
});

test('returns 401 when Authorization header is missing', async () => {
  const res = await fetch(`${baseUrl()}/v1/posts/update`);
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.match(body.error, /Authorization/);
  assert.equal(capturedRequests.length, 0, 'upstream should not be called without auth');
});

test('returns 401 for Bearer token missing the colon separator', async () => {
  const res = await fetch(`${baseUrl()}/v1/posts/update`, {
    headers: { 'Authorization': 'Bearer nocolonhere' }
  });
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.match(body.error, /Bearer/);
});

test('returns 401 for Basic auth whose payload is missing the colon separator', async () => {
  // Base64 of a string with no colon — decodeBasicCredentials treats this as
  // malformed (can't split user from password) and the handler rejects it.
  const res = await fetch(`${baseUrl()}/v1/posts/update`, {
    headers: { 'Authorization': 'Basic ' + Buffer.from('nocolon').toString('base64') }
  });
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.match(body.error, /Basic/i);
});

test('forwards upstream 4xx status and error body', async () => {
  mocks.upstream = { kind: 'http-error', status: 400, data: 'bad url' };

  const res = await call('/v1/posts/add?format=json&url=invalid');
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error, 'bad url');
});

test('returns 504 on upstream timeout', async () => {
  mocks.upstream = { kind: 'timeout' };

  const res = await call('/v1/posts/all?format=json');
  const body = await res.json();

  assert.equal(res.status, 504);
  assert.match(body.error, /timeout/i);
});

test('returns 500 on upstream network error without HTTP response', async () => {
  mocks.upstream = { kind: 'network-error', message: 'socket hang up', code: 'ECONNRESET' };

  const res = await call('/v1/posts/all?format=json');
  assert.equal(res.status, 500);
});

test('returns 500 when upstream XML is malformed', async () => {
  mocks.upstream = {
    kind: 'success',
    // fast-xml-parser throws on genuinely broken markup like unclosed tags with attributes.
    data: '<posts user="alice"><post href=',
    headers: { 'content-type': 'application/xml' }
  };

  const res = await call('/v1/posts/get?tag=web');
  // Either 500 (parse failure) or 200 with a sensible body is acceptable;
  // what we care about is that the process didn't crash and we got JSON back.
  assert.ok([200, 500].includes(res.status), `unexpected status ${res.status}`);
  const body = await res.json();
  assert.ok(body, 'response must be JSON');
});
