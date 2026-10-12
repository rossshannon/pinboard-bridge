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

// parseInt('1e3') is 1, which used to set a limit of one request.
process.env.PORT = '0';
process.env.IP_RATE_LIMIT_MAX = '1e3';

const { server } = require('../web.js');

before(async () => {
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
});

after(() => {
  server.close();
});

test('a malformed IP_RATE_LIMIT_MAX falls back to the default instead of being misread', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/tags/get?format=json`, {
    headers: { 'Authorization': 'Bearer testuser:DEADBEEF12345678' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('ratelimit-limit'), '300');
});

test('a limit too long to be an exact integer falls back to the default', () => {
  const { parseIntSetting } = require('../web.js');
  process.env.TEST_HUGE_LIMIT = '9'.repeat(400);
  assert.equal(parseIntSetting('TEST_HUGE_LIMIT', 300, { min: 1 }), 300);
  process.env.TEST_HUGE_LIMIT = '0';
  assert.equal(parseIntSetting('TEST_HUGE_LIMIT', 300, { min: 1 }), 300);
  process.env.TEST_HUGE_LIMIT = ' 42 ';
  assert.equal(parseIntSetting('TEST_HUGE_LIMIT', 300, { min: 1 }), 42);
  delete process.env.TEST_HUGE_LIMIT;
});
