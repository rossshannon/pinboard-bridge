// Tests for the fixes from the November 2026 audit (v2.3.1).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');

let upstream = null;
const captured = [];
axios.defaults.adapter = async config => {
  captured.push(config.url);
  if (upstream?.networkError) {
    const err = new Error('connect ECONNREFUSED 10.1.2.3:443');
    err.code = 'ECONNREFUSED';
    err.config = config;
    throw err;
  }
  if (config.url.startsWith('https://api.pinboard.in/')) {
    return { data: { ok: true }, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, config, request: {} };
  }
  return { data: '<html><head><title>Page</title></head></html>', status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' }, config, request: {} };
};

process.env.PORT = '0';
process.env.PINBOARD_MIN_INTERVAL_MS = '0';
const { server, decodeHead, isPinboardV1Path, extractPreviewMetadata } = require('../web.js');

before(async () => {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
});
after(() => server.close());
beforeEach(() => {
  upstream = null;
  captured.length = 0;
});

const AUTH = 'Bearer testuser:DEADBEEF';

// fetch() tidies dot segments away before sending, so send the path raw.
const rawGet = path => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path, headers: { Authorization: AUTH } }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  });
  req.on('error', reject);
  req.end();
});

for (const path of ['/v1/../v2/secret', '/v1/%2e%2e/v2/secret', '/v1/%2E%2E/v2/secret', '/v1/posts/../../x', '/v1/.%2e/x', '/v1/..']) {
  test(`a path that climbs out of /v1/ is refused, not forwarded: ${path}`, async () => {
    const res = await rawGet(`${path}?format=json`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid API path' });
    assert.deepEqual(captured, []);
  });
}

test('dot segments that stay inside /v1/ still go through', async () => {
  const res = await rawGet('/v1/posts/../tags/get?format=json');
  assert.equal(res.status, 200);
  assert.equal(captured.length, 1);
  // The HTTP client resolves it to the same place the guard checked.
  assert.equal(new URL(captured[0]).pathname, '/v1/tags/get');
  assert.equal(isPinboardV1Path('/v1/tags/get'), true);
  assert.equal(isPinboardV1Path('/v1/notes/8e5d6964bb810e0050b0'), true);
  assert.equal(isPinboardV1Path('/v1/\\..\\..\\x'), false);
});

test('bracketed query keys reach Pinboard as they were sent', async () => {
  const res = await rawGet('/v1/posts/get?format=json&a[b]=c&tag=x&tag=y');
  assert.equal(res.status, 200);
  const sent = new URL(captured[0]).searchParams;
  assert.equal(sent.get('a[b]'), 'c');
  assert.equal(sent.get('a'), null);
  assert.deepEqual(sent.getAll('tag'), ['x', 'y']);
  assert.equal(sent.get('auth_token'), 'testuser:DEADBEEF');
});

test('an auth_token in the query is still dropped in favour of the header', async () => {
  await rawGet('/v1/posts/get?format=json&auth_token=someone:ELSE');
  assert.deepEqual(new URL(captured[0]).searchParams.getAll('auth_token'), ['testuser:DEADBEEF']);
});

test('suggest-with-preview reports a network failure by kind, without the raw error', async () => {
  upstream = { networkError: true };
  const res = await rawGet('/posts/suggest-with-preview?url=https%3A%2F%2Fexample.com%2F');
  assert.equal(res.status, 200);
  assert.equal(res.body.suggestionsStatus, 'error');
  assert.equal(res.body.suggestionsError, 'Pinboard API is unreachable');
  assert.doesNotMatch(JSON.stringify(res.body), /10\.1\.2\.3|ECONNREFUSED/);
});

test('decodeHead uses the charset from the Content-Type header', () => {
  const bytes = Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0x93, 0xfa, 0x96, 0x7b]); // <title>日本 in Shift_JIS
  assert.equal(decodeHead(bytes, 'text/html; charset=Shift_JIS'), '<title>日本');
  assert.equal(decodeHead(bytes, 'text/html; charset="shift_jis"'), '<title>日本');
});

test('decodeHead falls back to a <meta charset> or http-equiv tag', () => {
  const cafe = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in windows-1252
  const viaMeta = Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>'), cafe]);
  assert.equal(decodeHead(viaMeta, 'text/html'), '<meta charset="windows-1252"><title>café');
  const viaHttpEquiv = Buffer.concat([Buffer.from('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1"><title>'), cafe]);
  assert.match(decodeHead(viaHttpEquiv), /<title>café$/);
});

test('decodeHead defaults to UTF-8, honours a byte-order mark, and survives an unknown charset', () => {
  const utf8 = Buffer.from('<title>café ✓</title>');
  assert.equal(decodeHead(utf8, 'text/html'), '<title>café ✓</title>');
  assert.equal(decodeHead(utf8, 'text/html; charset=utf8'), '<title>café ✓</title>');
  assert.equal(decodeHead(utf8, 'text/html; charset=klingon-1'), '<title>café ✓</title>');
  // The mark wins over a header that says otherwise, and is not part of the text.
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  assert.equal(decodeHead(withBom, 'text/html; charset=iso-8859-1'), '<title>café ✓</title>');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<title>hi</title>', 'utf16le')]);
  assert.equal(decodeHead(utf16), '<title>hi</title>');
  // A meta tag readable as ASCII that claims UTF-16 is treated as UTF-8.
  assert.equal(decodeHead(Buffer.from('<meta charset="utf-16"><title>ok</title>')), '<meta charset="utf-16"><title>ok</title>');
  assert.equal(decodeHead(Buffer.alloc(0)), '');
});

test('siteHandleUrl is only built from something shaped like a Twitter handle', () => {
  const page = handle => `<html><head><title>T</title><meta name="twitter:site" content="${handle}"></head></html>`;
  const url = 'https://example.com/a';
  assert.equal(extractPreviewMetadata(page('@example_1'), url, url).siteHandleUrl, 'https://twitter.com/example_1');
  assert.equal(extractPreviewMetadata(page('example'), url, url).siteHandleUrl, 'https://twitter.com/example');
  for (const bad of ['../../i/flow/login', 'a?b=c', 'two words', '@', 'waytoolongforatwitterhandle', 'é']) {
    const preview = extractPreviewMetadata(page(bad), url, url);
    assert.equal(preview.siteHandleUrl, null, bad);
    assert.equal(preview.siteHandle, bad, 'the handle text itself is still returned');
  }
});

test('twitter:creator is used when twitter:site is absent', () => {
  const html = '<html><head><title>T</title><meta name="twitter:creator" content="@writer"></head></html>';
  const preview = extractPreviewMetadata(html, 'https://example.com/', 'https://example.com/');
  assert.equal(preview.siteHandle, '@writer');
  assert.equal(preview.siteHandleUrl, 'https://twitter.com/writer');
});
