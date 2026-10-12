const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const axios = require('axios');

const TARGET_URL = 'https://example.com/article';
const HEAD_HTML = [
  '<html><head>',
  '<title>Streamed Page</title>',
  '<meta property="og:description" content="Read from the head only">',
  '</head>'
].join('');

const calls = [];
const mocks = { preview: null };

const pinboardResponse = config => ({
  data: { ok: true },
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  config,
  request: {}
});

axios.defaults.adapter = async (config) => {
  const url = config.url || '';
  calls.push({ url, at: Date.now() });
  if (url.startsWith('https://api.pinboard.in/')) {
    return pinboardResponse(config);
  }
  if (url === TARGET_URL && mocks.preview) {
    return mocks.preview(config);
  }
  throw new Error(`Unexpected request to ${url}`);
};

process.env.PORT = '0';
process.env.PINBOARD_MIN_INTERVAL_MS = '300';
process.env.PINBOARD_MAX_QUEUE_MS = '500';

const { server } = require('../web.js');

before(async () => {
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
});

after(() => {
  server.close();
});

beforeEach(async () => {
  // Let the previous test's pacing slots expire so each test starts clean.
  await new Promise(resolve => setTimeout(resolve, 1000));
  calls.length = 0;
  mocks.preview = null;
});

const baseUrl = () => `http://127.0.0.1:${server.address().port}`;

const basic = user => 'Basic ' + Buffer.from(`${user}:secret`).toString('base64');

const call = (pathAndQuery, user = 'alice') => fetch(`${baseUrl()}${pathAndQuery}`, {
  headers: { Authorization: basic(user) }
});

const htmlResponse = (config, data) => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'text/html; charset=utf-8' },
  config,
  request: { res: { responseUrl: TARGET_URL } }
});

test('/preview returns page metadata without calling Pinboard', async () => {
  mocks.preview = config => htmlResponse(config, Buffer.from(HEAD_HTML + '<body></body></html>'));

  const res = await call(`/preview?url=${encodeURIComponent(TARGET_URL)}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.preview.title, 'Streamed Page');
  assert.equal(body.previewStatus, 'fresh');
  assert.equal(body.suggestions, undefined);
  assert.ok(calls.every(c => !c.url.includes('api.pinboard.in')), 'no Pinboard call expected');
});

test('/preview requires an Authorization header', async () => {
  const res = await fetch(`${baseUrl()}/preview?url=${encodeURIComponent(TARGET_URL)}`);
  assert.equal(res.status, 401);
});

test('/preview applies the SSRF guard', async () => {
  const res = await call(`/preview?url=${encodeURIComponent('http://127.0.0.1/admin')}`);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('/preview stops reading a streamed page at </head>', async () => {
  let bodyChunksRead = 0;
  mocks.preview = config => {
    // </head> split across two chunks, followed by a body that never ends.
    const stream = new Readable({
      read() {
        if (bodyChunksRead === 0) {
          this.push(HEAD_HTML.slice(0, -4));
          this.push(HEAD_HTML.slice(-4));
        }
        bodyChunksRead += 1;
        if (bodyChunksRead < 10000) {
          this.push('<p>' + 'x'.repeat(1024) + '</p>');
        }
      }
    });
    return htmlResponse(config, stream);
  };

  const res = await call(`/preview?url=${encodeURIComponent(TARGET_URL)}`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.preview.description, 'Read from the head only');
  assert.ok(bodyChunksRead < 100, `read ${bodyChunksRead} body chunks; expected to stop at </head>`);
});

test('Pinboard calls for the same user are spaced apart', async () => {
  await Promise.all([
    call('/v1/posts/get?format=json&url=a'),
    call('/v1/posts/suggest?format=json&url=a')
  ]);

  const pinboardCalls = calls.filter(c => c.url.includes('api.pinboard.in'));
  assert.equal(pinboardCalls.length, 2);
  const gap = pinboardCalls[1].at - pinboardCalls[0].at;
  assert.ok(gap >= 280, `expected the second call at least ~300ms after the first, got ${gap}ms`);
});

test('Pinboard calls for different users are not spaced', async () => {
  await Promise.all([
    call('/v1/posts/get?format=json&url=a', 'alice'),
    call('/v1/posts/get?format=json&url=a', 'bob')
  ]);

  const pinboardCalls = calls.filter(c => c.url.includes('api.pinboard.in'));
  assert.equal(pinboardCalls.length, 2);
  const gap = Math.abs(pinboardCalls[1].at - pinboardCalls[0].at);
  assert.ok(gap < 200, `expected both calls together, got a ${gap}ms gap`);
});

test('a call that would queue past the cap goes straight through', async () => {
  const startedAt = Date.now();
  await Promise.all([
    call('/v1/posts/get?format=json&url=1'),
    call('/v1/posts/get?format=json&url=2'),
    call('/v1/posts/get?format=json&url=3')
  ]);

  const offsets = calls
    .filter(c => c.url.includes('api.pinboard.in'))
    .map(c => c.at - startedAt)
    .sort((a, b) => a - b);
  assert.equal(offsets.length, 3);
  // Slots: 0ms, 300ms, then 600ms would exceed the 500ms cap, so the third
  // call is sent immediately instead of waiting.
  assert.ok(offsets[1] < 200, `expected one call to skip the queue, got offsets ${offsets.join(', ')}`);
  assert.ok(offsets[2] >= 280, `expected one call to wait its turn, got offsets ${offsets.join(', ')}`);
});

test('suggest-with-preview logs how long each half took', async () => {
  mocks.preview = config => htmlResponse(config, Buffer.from(HEAD_HTML));
  const lines = [];
  const originalInfo = console.info;
  console.info = (...args) => { lines.push(args.join(' ')); };
  try {
    const res = await call(`/posts/suggest-with-preview?url=${encodeURIComponent(TARGET_URL)}`);
    assert.equal(res.status, 200);
  } finally {
    console.info = originalInfo;
  }

  const summary = lines.find(line => line.startsWith('[preview] route=suggest-with-preview'));
  assert.ok(summary, `expected a summary log line, got: ${lines.join(' | ')}`);
  assert.match(summary, /suggestMs=\d+/);
  assert.match(summary, /previewMs=\d+/);
  const pinboardLine = lines.find(line => line.startsWith('[pinboard]'));
  assert.match(pinboardLine, /call=posts\/suggest waitMs=\d+ upstreamMs=\d+ outcome=ok/);
  assert.ok(!pinboardLine.includes('secret'), 'credentials must not be logged');
});

test('spacing is keyed on the whole credential, so a wrong token cannot use up a user\'s slots', async () => {
  const withToken = token => fetch(`${baseUrl()}/v1/posts/get?format=json&url=a`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`alice:${token}`).toString('base64') }
  });
  await Promise.all([withToken('wrong'), withToken('secret')]);

  const pinboardCalls = calls.filter(c => c.url.includes('api.pinboard.in'));
  assert.equal(pinboardCalls.length, 2);
  const gap = Math.abs(pinboardCalls[1].at - pinboardCalls[0].at);
  assert.ok(gap < 200, `expected no spacing between different credentials, got a ${gap}ms gap`);
});

test('time spent queueing comes out of the Pinboard timeout', async () => {
  const timeouts = [];
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = async config => {
    if (config.url.startsWith('https://api.pinboard.in/')) timeouts.push(config.timeout);
    return originalAdapter(config);
  };
  try {
    await Promise.all([
      call('/v1/posts/get?format=json&url=1'),
      call('/v1/posts/get?format=json&url=2')
    ]);
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
  timeouts.sort((a, b) => b - a);
  assert.equal(timeouts[0], 25000);
  assert.ok(timeouts[1] <= 24720 && timeouts[1] >= 24600, `expected ~24700ms, got ${timeouts[1]}`);
});

test('a username cannot forge extra log lines or fields', async () => {
  const lines = [];
  const originalInfo = console.info;
  console.info = (...args) => { lines.push(args.join(' ')); };
  try {
    const forged = 'bob\nFAKE [pinboard] user=admin';
    await fetch(`${baseUrl()}/v1/posts/get?format=json&url=a`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${forged}:secret`).toString('base64') }
    });
  } finally {
    console.info = originalInfo;
  }
  const pinboardLines = lines.filter(line => line.includes('[pinboard]'));
  assert.equal(pinboardLines.length, 1);
  assert.ok(!pinboardLines[0].includes('\n'));
  assert.match(pinboardLines[0], /^\[pinboard\] user=bob\?FAKE\?\?pinboard\?\?user\?admin call=/);
});

test('a queued call is dropped if the client has gone by its turn', async () => {
  const first = call('/v1/posts/get?format=json&url=1');
  const controller = new AbortController();
  const second = fetch(`${baseUrl()}/v1/posts/get?format=json&url=2`, {
    headers: { Authorization: basic('alice') },
    signal: controller.signal
  }).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  await Promise.all([first, second]);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(calls.filter(c => c.url.includes('api.pinboard.in')).length, 1);
});


test('a dropped call gives its slot back to the next one', async () => {
  const startedAt = Date.now();
  const first = call('/v1/posts/get?format=json&url=1');
  const controller = new AbortController();
  const dropped = fetch(`${baseUrl()}/v1/posts/get?format=json&url=2`, {
    headers: { Authorization: basic('alice') },
    signal: controller.signal
  }).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  await Promise.all([first, dropped]);
  // Give the bridge a moment to see the disconnect.
  await new Promise(resolve => setTimeout(resolve, 50));
  await call('/v1/posts/get?format=json&url=3');

  const offsets = calls.filter(c => c.url.includes('api.pinboard.in')).map(c => c.at - startedAt);
  assert.equal(offsets.length, 2);
  // The third call takes the dropped call's slot (~300ms). Without the
  // release it would face a 600ms slot, over the 500ms cap, and skip the queue.
  assert.ok(offsets[1] >= 280 && offsets[1] < 500, `expected the next call at ~300ms, got ${offsets[1]}ms`);
});
