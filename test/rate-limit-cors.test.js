const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

axios.defaults.adapter = async (config) => ({
  data: { ok: true },
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  config,
  request: { res: { responseUrl: config.url } }
});

// Captured once at module load, so set before requiring ../web.js. Each test
// file runs in its own subprocess, so this tiny limit stays local to it.
process.env.PORT = '0';
process.env.ALLOWED_ORIGINS = 'https://allowed.example.com';
process.env.IP_RATE_LIMIT_MAX = '2';

const { server } = require('../web.js');

before(async () => {
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
});

after(() => {
  server.close();
});

const EXPOSED = 'RateLimit-Policy,RateLimit-Limit,RateLimit-Remaining,RateLimit-Reset,Retry-After';

const call = () => fetch(`http://127.0.0.1:${server.address().port}/v1/tags/get?format=json`, {
  headers: {
    'Origin': 'https://allowed.example.com',
    'Authorization': 'Bearer testuser:DEADBEEF12345678'
  }
});

test('a request from a disallowed origin is refused before it uses any quota', async () => {
  const refused = await fetch(`http://127.0.0.1:${server.address().port}/v1/tags/get?format=json`, {
    headers: {
      'Origin': 'https://evil.example.com',
      'Authorization': 'Bearer testuser:DEADBEEF12345678'
    }
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('ratelimit-remaining'), null);
});

test('a throttled /v1 response still carries CORS headers so the browser can read it', async () => {
  const first = await call();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('access-control-expose-headers'), EXPOSED);

  // Two real requests fit the limit of 2, which also shows the refused
  // cross-origin request in the previous test used none of it.
  assert.equal((await call()).status, 200);
  const throttled = await call();
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('access-control-allow-origin'), 'https://allowed.example.com');
  assert.equal(throttled.headers.get('access-control-expose-headers'), EXPOSED);
  assert.ok(throttled.headers.get('retry-after'), 'expected Retry-After on the 429');
  assert.ok(throttled.headers.get('ratelimit-reset'), 'expected RateLimit-Reset on the 429');
  const body = await throttled.json();
  assert.match(body.error, /too many requests/i);
});
