// The Pinboard call's deadline covers the whole response, not just gaps in it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.PORT = '0';
process.env.PINBOARD_MIN_INTERVAL_MS = '0';
process.env.PINBOARD_TOTAL_BUDGET_MS = '1000';

// Like a Pinboard response that keeps trickling in: never finishes, never
// goes quiet long enough for axios's own timeout, until the call is aborted.
axios.defaults.adapter = config => new Promise((resolve, reject) => {
  config.signal?.addEventListener('abort', () => reject(new axios.CanceledError('canceled', null, config)));
});

const { server, parseIntSetting } = require('../web.js');

before(async () => {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
});

after(() => {
  server.close();
});

test('a Pinboard response that never finishes is cut off at the budget with a 504', { timeout: 5000 }, async () => {
  const startedAt = Date.now();
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/posts/get?format=json&url=a`, {
    headers: { Authorization: 'Basic ' + Buffer.from('alice:secret').toString('base64') }
  });
  assert.equal(res.status, 504);
  assert.ok(Date.now() - startedAt < 2500, 'expected the call to stop at its budget');
});

test('whole-number settings reject anything that is not one', () => {
  const read = (raw, min = 1) => {
    process.env.TEST_SETTING = raw;
    try {
      return parseIntSetting('TEST_SETTING', 42, { min });
    } finally {
      delete process.env.TEST_SETTING;
    }
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(read('300'), 300);
    assert.equal(read(' 7 '), 7);
    assert.equal(read('-1'), 42);
    assert.equal(read('1e3'), 42);
    assert.equal(read('300ms'), 42);
    assert.equal(read('0'), 42);
    assert.equal(read('0', 0), 0);
    assert.equal(read('999', 1000), 42);
    assert.equal(read(''), 42);
  } finally {
    console.warn = originalWarn;
  }
});
