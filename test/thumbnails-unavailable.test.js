// Boots the bridge in a process where the image library cannot be loaded at
// all, as on a host with no sharp binary for its platform: only thumbnails
// may be lost.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');

const realLoad = Module._load;
let sharpLoads = 0;
Module._load = function (request, ...rest) {
  if (request === 'sharp') {
    sharpLoads += 1;
    throw new Error('Could not load the "sharp" module using the test runtime');
  }
  return realLoad.call(this, request, ...rest);
};

process.env.PORT = '0';
const { server: bridge, addressGuard, isPrivateAddress } = require('../web.js');

// Let the loopback test server through; everything else keeps the real rules.
addressGuard.isPrivate = address => address !== '127.0.0.1' && isPrivateAddress(address);

const requests = [];
const target = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url !== '/article') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><head><title>Article</title><meta property="og:image" content="/og.png"></head></html>');
});
const errors = [];
const originalError = console.error;

before(async () => {
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  if (!bridge.listening) await new Promise(resolve => bridge.once('listening', resolve));
  console.error = (...args) => { errors.push(args.join(' ')); };
});

after(() => {
  console.error = originalError;
  Module._load = realLoad;
  target.closeAllConnections();
  target.close();
  bridge.close();
});

const call = path => fetch(`http://127.0.0.1:${bridge.address().port}${path}`, {
  headers: { Authorization: 'Basic ' + Buffer.from('alice:secret').toString('base64') }
});
const pageUrl = () => encodeURIComponent(`http://127.0.0.1:${target.address().port}/article`);

test('the bridge starts without loading sharp', async () => {
  assert.equal(sharpLoads, 0);
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'healthy');
  const missing = await call('/nope');
  assert.equal(missing.status, 404);
});

test('plain previews work and never touch sharp', async () => {
  const res = await call(`/preview?url=${pageUrl()}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['preview', 'previewStatus']);
  assert.equal(body.preview.title, 'Article');
  assert.equal(sharpLoads, 0);
});

test('thumbnail requests answer "unavailable", log the reason once and fetch no images', async () => {
  for (let i = 0; i < 3; i += 1) {
    const res = await call(`/preview?url=${pageUrl()}&thumbnails=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.preview.title, 'Article');
    assert.equal(body.previewStatus, 'fresh');
    assert.deepEqual(body.thumbnails, { image: null, favicon: null });
    assert.equal(body.thumbnailsStatus, 'unavailable');
  }
  assert.equal(sharpLoads, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Thumbnails are unavailable: the image library failed to load/);
  assert.ok(requests.every(url => url === '/article'), requests.join(', '));
});
