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

const call = () => fetch(`http://127.0.0.1:${server.address().port}/v1/tags/get?format=json`, {
  headers: {
    'Origin': 'https://allowed.example.com',
    'Authorization': 'Bearer testuser:DEADBEEF12345678'
  }
});

test('a throttled /v1 response still carries CORS headers so the browser can read it', async () => {
  const first = await call();
  assert.equal(first.status, 200);
  const exposed = (first.headers.get('access-control-expose-headers') || '').toLowerCase();
  assert.ok(exposed.includes('ratelimit-remaining'), `expected RateLimit-Remaining to be exposed, got "${exposed}"`);
  assert.ok(exposed.includes('retry-after'));

  await call();
  const throttled = await call();
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('access-control-allow-origin'), 'https://allowed.example.com');
  const body = await throttled.json();
  assert.match(body.error, /too many requests/i);
});
