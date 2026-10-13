// A wider queue cap than the other pacing tests, so three calls can queue.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const calls = [];
axios.defaults.adapter = async config => {
  calls.push({ url: config.url, at: Date.now() });
  return { data: { ok: true }, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, config, request: {} };
};

process.env.PORT = '0';
process.env.PINBOARD_MIN_INTERVAL_MS = '200';
process.env.PINBOARD_MAX_QUEUE_MS = '1000';

const { server, queuedPinboardCalls } = require('../web.js');

before(async () => {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
});

after(() => {
  server.close();
});

const request = (path, signal) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
  headers: { Authorization: 'Basic ' + Buffer.from('alice:secret').toString('base64') },
  signal
});

const until = async check => {
  while (!check()) await new Promise(resolve => setTimeout(resolve, 2));
};
const waitForCalls = count => until(() => calls.length >= count);
const waitForQueued = count => until(() => queuedPinboardCalls() === count);

test('dropping a call from the middle of the queue moves the later calls up', async () => {
  const startedAt = Date.now();
  const first = request('/v1/posts/get?format=json&url=1');
  await waitForCalls(1);
  const controller = new AbortController();
  const middle = request('/v1/posts/get?format=json&url=2', controller.signal).catch(() => null);
  await waitForQueued(1);
  const last = request('/v1/posts/get?format=json&url=3');
  await waitForQueued(2);
  controller.abort();
  await waitForQueued(1);
  await Promise.all([first, middle, last]);

  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes('url=3'));
  const offset = calls[1].at - startedAt;
  // Slots were 0, 200 and 400ms; with the middle call gone, the last takes 200ms.
  assert.ok(offset >= 180 && offset < 350, `expected the last call at ~200ms, got ${offset}ms`);
});
