// Tests for the fixes from the November 2026 audit (v2.3.1).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
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
const { server, readHead, decodeHead, isPinboardV1Path, isAuthTokenKey, extractPreviewMetadata } = require('../web.js');

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

const REFUSED_PATHS = [
  '/v1/../v2/secret', '/v1/%2e%2e/v2/secret', '/v1/%2E%2E/v2/secret', '/v1/posts/../../x', '/v1/.%2e/x', '/v1/..',
  // Dot segments joined by an encoded slash, which Pinboard's own server might resolve.
  '/v1/..%2f..%2fx', '/v1/%2e%2e%2fx', '/v1/posts/get/..%2f..%2f..%2fadmin',
  // Dot segments that would stay inside /v1/ are refused as well: one rule, no judgement calls.
  '/v1/posts/../tags/get', '/v1/./tags/get', '/v1/%2e/tags/get',
  '/v1/posts//get', '/v1//', '/v1/posts/get;x=1', '/v1/posts\\get'
];
for (const path of REFUSED_PATHS) {
  test(`a path that is not plain /v1/ segments is refused, not forwarded: ${path}`, async () => {
    const res = await rawGet(`${path}?format=json`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Invalid API path' });
    assert.deepEqual(captured, []);
  });
}

test('every real Pinboard API path is accepted, and sent as it came', async () => {
  const methods = ['posts/update', 'posts/add', 'posts/delete', 'posts/get', 'posts/recent', 'posts/dates', 'posts/all',
    'posts/suggest', 'tags/get', 'tags/delete', 'tags/rename', 'user/secret', 'user/api_token', 'notes/list',
    'notes/8e5d6964bb810e0050b0'];
  for (const method of methods) {
    assert.equal(isPinboardV1Path(`/v1/${method}`), true, method);
    assert.equal(isPinboardV1Path(`/v1/${method}/`), true, `${method}/`);
  }
  assert.equal(isPinboardV1Path('/v1/'), false);
  assert.equal(isPinboardV1Path('/v2/posts/get'), false);
  const res = await rawGet('/v1/notes/8e5d6964bb810e0050b0?format=json');
  assert.equal(res.status, 200);
  // The raw string handed to the HTTP client, not a re-parse of it.
  assert.equal(captured[0].split('?')[0], 'https://api.pinboard.in/v1/notes/8e5d6964bb810e0050b0');
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

test('an auth_token in the query is still dropped in favour of the header, however it is spelt', async () => {
  await rawGet('/v1/posts/get?format=json&auth_token=someone:ELSE&auth_token[]=a:B&auth_token[x]=c:D&auth%5ftoken=e:F&auth.token=g:H&AUTH_TOKEN=i:J&auth[token=k:L&auth_token%00x=m:N&%20auth_token=o:P&auth+token=q:R&tag=keep');
  const sent = new URL(captured[0]).searchParams;
  assert.deepEqual([...sent.keys()].sort(), ['auth_token', 'format', 'tag']);
  assert.deepEqual(sent.getAll('auth_token'), ['testuser:DEADBEEF']);
  assert.equal(isAuthTokenKey('auth_tokens'), false);
  assert.equal(isAuthTokenKey('my_auth_token'), false);
});

test('with Basic auth no auth_token of any spelling reaches Pinboard', async () => {
  const basic = 'Basic ' + Buffer.from('testuser:DEADBEEF').toString('base64');
  await fetch(`http://127.0.0.1:${server.address().port}/v1/posts/get?format=json&auth_token[]=someone:ELSE`, { headers: { Authorization: basic } });
  assert.deepEqual([...new URL(captured[0]).searchParams.keys()], ['format']);
});

test('suggest-with-preview reports a network failure by kind, without the raw error', async () => {
  upstream = { networkError: true };
  const res = await rawGet('/posts/suggest-with-preview?url=https%3A%2F%2Fexample.com%2F');
  assert.equal(res.status, 200);
  assert.equal(res.body.suggestionsStatus, 'error');
  assert.equal(res.body.suggestionsError, 'Pinboard API is unreachable');
  assert.doesNotMatch(JSON.stringify(res.body), /10\.1\.2\.3|ECONNREFUSED/);
});

const CAFE_1252 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21]); // "café!" in windows-1252 / latin1

test('decodeHead uses the Content-Type charset for bytes that are not UTF-8', () => {
  const bytes = Buffer.from([0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, 0x93, 0xfa, 0x96, 0x7b]); // <title>日本 in Shift_JIS
  assert.equal(decodeHead(bytes, 'text/html; charset=Shift_JIS'), '<title>日本');
  assert.equal(decodeHead(bytes, 'text/html; charset="shift_jis"'), '<title>日本');
});

test('decodeHead falls back to a <meta charset> or http-equiv tag', () => {
  const viaMeta = Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>'), CAFE_1252]);
  assert.equal(decodeHead(viaMeta, 'text/html'), '<meta charset="windows-1252"><title>café!');
  const viaHttpEquiv = Buffer.concat([Buffer.from('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1"><title>'), CAFE_1252]);
  assert.match(decodeHead(viaHttpEquiv), /<title>café!$/);
  // The header wins over the tag, as it does in a browser.
  const koi = Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>'), Buffer.from([0xd0, 0xd2, 0x21])]);
  assert.match(decodeHead(koi, 'text/html; charset=koi8-r'), /<title>пр!$/);
});

test('decodeHead reads valid UTF-8 as UTF-8 whatever else mentions a charset', () => {
  const expectUtf8 = (html, contentType = 'text/html') => assert.match(decodeHead(Buffer.from(html), contentType), /café ✓/, html);
  expectUtf8('<title>café ✓</title>');
  expectUtf8('<title>café ✓</title>', 'text/html; charset=utf8');
  // A server with a wrong default charset header in front of a UTF-8 page.
  expectUtf8('<meta charset="utf-8"><title>café ✓</title>', 'text/html; charset=ISO-8859-1');
  expectUtf8('<!-- <meta charset="iso-8859-1"> --><meta charset="utf-8"><title>café ✓</title>');
  expectUtf8('<meta name="description" content="set charset=latin1 in mysql"><title>café ✓</title>');
  expectUtf8('<meta name="x" data-charset="koi8-r"><title>café ✓</title>');
  // The byte-order mark is not part of the text.
  assert.equal(decodeHead(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<title>é</title>')])), '<title>é</title>');
  // A character cut in half where the read stopped doesn't make the page "not UTF-8".
  const cut = Buffer.from('<meta charset="iso-8859-1"><title>café ✓</title>✓');
  assert.match(decodeHead(cut.subarray(0, cut.length - 1)), /café ✓<\/title>$/);
});

test('decodeHead ignores charset mentions that are not a real declaration, for non-UTF-8 bytes too', () => {
  const page = prefix => Buffer.concat([Buffer.from(prefix + '<meta charset="windows-1252"><title>'), CAFE_1252]);
  assert.match(decodeHead(page('<!-- <meta charset="koi8-r"> -->')), /café!$/);
  assert.match(decodeHead(page('<meta name="description" content="charset=koi8-r">')), /café!$/);
  assert.match(decodeHead(page('<meta name="x" data-charset="koi8-r">')), /café!$/);
});

test('decodeHead handles UTF-16 marks, unknown charsets and empty input', () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<title>hi</title>', 'utf16le')]);
  assert.equal(decodeHead(utf16), '<title>hi</title>');
  // Not UTF-8, and the declared encoding is nonsense: lossy UTF-8, as before.
  assert.equal(decodeHead(CAFE_1252, 'text/html; charset=klingon-1'), 'caf\ufffd!');
  assert.equal(decodeHead(Buffer.concat([Buffer.from('<meta charset="utf-16"><title>'), CAFE_1252])), '<meta charset="utf-16"><title>caf\ufffd!');
  assert.equal(decodeHead(CAFE_1252), 'caf\ufffd!');
  assert.equal(decodeHead(Buffer.alloc(0)), '');
});

test('one stray byte does not hand a UTF-8 page to a wrong declared charset', () => {
  const page = Buffer.concat([Buffer.from('<meta charset="iso-8859-1"><title>café ✓ naïve</title></head><body>'), Buffer.from([0xe9, 0x21])]);
  assert.match(decodeHead(page, 'text/html; charset=ISO-8859-1'), /<title>café ✓ naïve<\/title>/);
});

test('labels that really mean UTF-16 or UTF-8 are not applied to bytes we could read as ASCII', () => {
  for (const label of ['ucs-2', 'unicode', 'csunicode', 'unicodefffe', 'iso-10646-ucs-2', 'utf-16le', 'UTF8', 'unicode-1-1-utf-8']) {
    const page = Buffer.concat([Buffer.from(`<meta charset="${label}"><title>`), CAFE_1252]);
    assert.equal(decodeHead(page), `<meta charset="${label}"><title>caf\ufffd!`, label);
    assert.match(decodeHead(page, `text/html; charset=${label}`), /<title>caf\ufffd!$/, label);
  }
});

test('a Content-Type charset we cannot use does not stop the <meta> tag being read', () => {
  const page = Buffer.concat([Buffer.from('<meta charset="windows-1252"><title>'), CAFE_1252]);
  for (const label of ['utf8mb4', 'none', 'binary']) {
    assert.match(decodeHead(page, `text/html; charset=${label}`), /<title>café!$/, label);
  }
});

test('a <meta charset> after the first 1024 bytes is not looked for', () => {
  const page = Buffer.concat([Buffer.from('<!--' + 'x'.repeat(1100) + '--><meta charset="windows-1252"><title>'), CAFE_1252]);
  assert.match(decodeHead(page), /<title>caf\ufffd!$/);
});

test('decodeHead stays fast, and does not throw, on hostile heads', async () => {
  // Each is 64 KB or more, has a non-UTF-8 byte and declares no charset: the
  // worst case, where every fallback is tried.
  const attributes = Array.from({ length: 70000 }, (unused, index) => `a${index}`).join(' ');
  const hostile = {
    'unclosed <meta tags': '<meta '.repeat(85000),
    'one <meta> with 70,000 attributes': `<meta ${attributes}`,
    'deeply nested templates': '<template>'.repeat(7000),
    'deeply nested divs': '<div>'.repeat(13000)
  };
  for (const [name, html] of Object.entries(hostile)) {
    const bytes = Buffer.concat([Buffer.from(html), Buffer.from([0xff])]);
    const startedAt = Date.now();
    assert.equal(typeof decodeHead(bytes, 'text/html'), 'string', name);
    assert.ok(Date.now() - startedAt < 1000, `${name} took ${Date.now() - startedAt} ms`);
    // The same through the stream reader, where a throw would be uncaught.
    assert.equal(typeof await readHead(Readable.from([bytes]), 'text/html'), 'string', name);
  }
});

test('siteHandleUrl is only built from something shaped like a Twitter handle', () => {
  const page = handle => `<html><head><title>T</title><meta name="twitter:site" content="${handle}"></head></html>`;
  const url = 'https://example.com/a';
  assert.equal(extractPreviewMetadata(page('@example_1'), url, url).siteHandleUrl, 'https://twitter.com/example_1');
  assert.equal(extractPreviewMetadata(page('example'), url, url).siteHandleUrl, 'https://twitter.com/example');
  for (const bad of ['../../i/flow/login', 'a?b=c', 'two words', '@', '@@example', 'https://twitter.com/example', 'waytoolongforatwitterhandle', 'é']) {
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
