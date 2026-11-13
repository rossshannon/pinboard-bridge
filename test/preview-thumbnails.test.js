// Runs /preview?thumbnails=1 against a real local HTTP server with axios's
// real adapter, so the image fetches go through the same SSRF lookup,
// redirect guard, byte caps and deadline as they do in production.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const sharp = require('sharp');

process.env.PORT = '0';
process.env.PAGE_PREVIEW_RATE_LIMIT_MAX = '1000';
const { server: bridge, addressGuard, isPrivateAddress, thumbnailing } = require('../web.js');

// Let the loopback test server through; everything else keeps the real rules.
addressGuard.isPrivate = address => address !== '127.0.0.1' && isPrivateAddress(address);

const HOSTS = { 'thumbs.test': '127.0.0.1', 'elsewhere.test': '127.0.0.1', 'private.test': '10.0.0.1' };
const realLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const address = HOSTS[hostname];
  if (!address) return realLookup(hostname, options, callback);
  if (options && options.all) return process.nextTick(callback, null, [{ address, family: 4 }]);
  return process.nextTick(callback, null, address, 4);
};

// Routes are keyed on the path; `hits` records every request as "host path".
let routes = {};
let hits = [];
const target = http.createServer((req, res) => {
  hits.push(`${req.headers.host.split(':')[0]} ${req.url}`);
  const handler = routes[req.url];
  if (handler) return handler(req, res);
  res.writeHead(404).end();
});
let port;
let base;
const logLines = [];
const originalInfo = console.info;

before(async () => {
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  port = target.address().port;
  base = `http://thumbs.test:${port}`;
  if (!bridge.listening) await new Promise(resolve => bridge.once('listening', resolve));
  console.info = (...args) => { logLines.push(args.join(' ')); };
});

after(() => {
  console.info = originalInfo;
  dns.lookup = realLookup;
  target.closeAllConnections();
  target.close();
  bridge.close();
});

// Wait until nothing a test set going is still running: every fetch, decode
// and job place it started has ended.
const settled = async () => {
  const idle = () => thumbnailing.inFlight.size === 0 && thumbnailing.fetchesInFlight.size === 0
    && thumbnailing.jobs.active === 0 && thumbnailing.decodeGate.active === 0;
  for (let i = 0; i < 1000 && !idle(); i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(idle(), 'thumbnail work was still running');
  assert.equal(thumbnailing.jobs.perClient.size, 0);
  assert.equal(thumbnailing.decodeGate.held.size, 0);
  assert.equal(thumbnailing.decodeGate.queues.size, 0);
};

beforeEach(async () => {
  // No work outlives the test that started it.
  await settled();
  routes = {};
  hits = [];
  thumbnailing.cache.clear();
});

const hitCount = path => hits.filter(hit => hit.endsWith(` ${path}`)).length;

const openConnections = () => new Promise((resolve, reject) => {
  target.getConnections((err, count) => (err ? reject(err) : resolve(count)));
});

// Wait for the bridge to have hung up on the test server.
const allClosed = async () => {
  for (let i = 0; i < 50; i += 1) {
    if (await openConnections() === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
};

const AUTH = { Authorization: 'Basic ' + Buffer.from('alice:secret').toString('base64') };
// Headers for a request that reaches the bridge from the given client IP
// (the bridge trusts one proxy hop, as on Heroku).
const from = ip => ({ ...AUTH, 'X-Forwarded-For': ip });

// Run with sharp wrapped: `wrap` gets each pipeline the bridge creates and
// returns the one to use. Returns a function that puts the real sharp back.
const withSharp = wrap => {
  const real = thumbnailing.engine.get();
  thumbnailing.engine.sharp = (...args) => wrap(real(...args));
  return () => { thumbnailing.engine.sharp = real; };
};

// Call the bridge's /preview for a page on the test server. Resolves to the
// status, the parsed body, the raw body and the [preview] log line.
// (The log is whatever was logged while the call ran, so it is only
// meaningful for calls made one at a time.)
const preview = async (pageUrl, query = '&thumbnails=1', headers = AUTH) => {
  const logStart = logLines.length;
  const res = await fetch(`http://127.0.0.1:${bridge.address().port}/preview?url=${encodeURIComponent(pageUrl)}${query}`, { headers });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text, log: logLines.slice(logStart).join('\n'), cacheControl: res.headers.get('cache-control') };
};

const page = (...headTags) => (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<html><head>${headTags.join('')}</head><body></body></html>`);
};
const serve = (bytes, contentType = 'image/png') => (req, res) => {
  res.writeHead(200, { 'content-type': contentType, 'content-length': bytes.length });
  res.end(bytes);
};

const solid = (width, height, background = '#c33') => sharp({ create: { width, height, channels: 4, background } });

// Decode a data: URI the bridge returned, checking its fixed MIME type.
const decoded = async (thumbnail, mime) => {
  const prefix = `data:${mime};base64,`;
  assert.ok(thumbnail.dataUri.startsWith(prefix), thumbnail.dataUri.slice(0, 40));
  const bytes = Buffer.from(thumbnail.dataUri.slice(prefix.length), 'base64');
  return { bytes, metadata: await sharp(bytes).metadata() };
};

// An ICO entry stored as a bitmap: BITMAPINFOHEADER, bottom-up BGR(A) rows,
// then the 1-bit mask.
const icoBitmap = (size, bitCount, [r, g, b, a]) => {
  const stride = Math.ceil((size * bitCount) / 32) * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const data = Buffer.alloc(40 + stride * size + maskStride * size);
  data.writeUInt32LE(40, 0);
  data.writeInt32LE(size, 4);
  data.writeInt32LE(size * 2, 8);
  data.writeUInt16LE(1, 12);
  data.writeUInt16LE(bitCount, 14);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = 40 + y * stride + x * (bitCount / 8);
      data[at] = b;
      data[at + 1] = g;
      data[at + 2] = r;
      if (bitCount === 32) data[at + 3] = a;
    }
  }
  return data;
};

// An ICO entry stored as a palette bitmap: header, colour table, packed
// bottom-up rows of indexes, then the mask. `transparent` lists [x, y] pixels
// whose mask bit is set; `coloursUsed` writes a shorter colour table.
const icoPaletteBitmap = (size, bitCount, palette, indexAt, { transparent = [], coloursUsed = 0 } = {}) => {
  const colours = coloursUsed || (1 << bitCount);
  const stride = Math.ceil((size * bitCount) / 32) * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const pixelsAt = 40 + colours * 4;
  const maskAt = pixelsAt + stride * size;
  const data = Buffer.alloc(maskAt + maskStride * size);
  data.writeUInt32LE(40, 0);
  data.writeInt32LE(size, 4);
  data.writeInt32LE(size * 2, 8);
  data.writeUInt16LE(1, 12);
  data.writeUInt16LE(bitCount, 14);
  data.writeUInt32LE(coloursUsed, 32);
  palette.slice(0, colours).forEach(([r, g, b], i) => data.set([b, g, r, 0], 40 + i * 4));
  const perByte = 8 / bitCount;
  for (let y = 0; y < size; y += 1) {
    const row = pixelsAt + (size - 1 - y) * stride;
    for (let x = 0; x < size; x += 1) {
      data[row + Math.floor(x / perByte)] |= indexAt(x, y) << ((perByte - 1 - (x % perByte)) * bitCount);
    }
  }
  for (const [x, y] of transparent) {
    data[maskAt + (size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return data;
};

// An .ico file from entries of { size, bitCount, data }, with optional
// `offset` and `length` overrides for writing a lying directory.
const icoFile = entries => {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((entry, i) => {
    const at = 6 + 16 * i;
    header[at] = entry.size === 256 ? 0 : entry.size;
    header[at + 1] = entry.size === 256 ? 0 : entry.size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(entry.bitCount || 32, at + 6);
    header.writeUInt32LE(entry.length ?? entry.data.length, at + 8);
    header.writeUInt32LE(entry.offset ?? offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([header, ...entries.map(entry => entry.data)]);
};

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><image href="http://localhost/secret.png"/><rect width="64" height="64" fill="red"/></svg>');

// ---- Happy paths ----

test('returns a WebP image thumbnail and a PNG icon thumbnail as data: URIs', async () => {
  routes['/article'] = page(
    '<title>Article</title>',
    '<meta property="og:image" content="/og.jpg">',
    '<link rel="icon" type="image/png" href="/icon.png">'
  );
  routes['/og.jpg'] = serve(await solid(1200, 630).jpeg().toBuffer(), 'image/jpeg');
  routes['/icon.png'] = serve(await solid(64, 64, '#36c').png().toBuffer());

  const { status, body, log, cacheControl } = await preview(`${base}/article`);
  assert.equal(status, 200);
  assert.equal(cacheControl, 'no-store');
  assert.deepEqual(Object.keys(body), ['preview', 'previewStatus', 'thumbnails', 'thumbnailsStatus']);
  assert.equal(body.thumbnailsStatus, 'complete');
  assert.equal(body.preview.title, 'Article');
  assert.equal(body.preview.imageUrl, `${base}/og.jpg`);
  assert.equal(body.preview.faviconUrl, `${base}/icon.png`);
  assert.equal(body.previewStatus, 'fresh');

  const { image, favicon } = body.thumbnails;
  assert.deepEqual(Object.keys(image), ['dataUri', 'width', 'height']);
  assert.deepEqual([image.width, image.height], [240, 126]);
  const imageOut = await decoded(image, 'image/webp');
  assert.equal(imageOut.metadata.format, 'webp');
  assert.deepEqual([imageOut.metadata.width, imageOut.metadata.height], [240, 126]);

  assert.deepEqual([favicon.width, favicon.height], [32, 32]);
  const faviconOut = await decoded(favicon, 'image/png');
  assert.equal(faviconOut.metadata.format, 'png');
  assert.deepEqual([faviconOut.metadata.width, faviconOut.metadata.height], [32, 32]);

  assert.match(log, /\[preview\] route=preview user=alice host=thumbs\.test outcome=preview_generated previewMs=\d+ thumbs=complete image=ok imageSource=declared imageMs=\d+ favicon=ok faviconSource=declared faviconMs=\d+$/);
  assert.ok(!log.includes('secret'), 'the token must never be logged');
  assert.ok(await allClosed(), 'expected the bridge to close its connections');
});

test('without thumbnails=1 the response and the fetches are exactly as before', async () => {
  routes['/article'] = page(
    '<title>Article</title>',
    '<meta property="og:image" content="/og.jpg">',
    '<link rel="icon" href="/icon.png">'
  );
  routes['/og.jpg'] = serve(await solid(600, 315).jpeg().toBuffer(), 'image/jpeg');
  routes['/icon.png'] = serve(await solid(64, 64).png().toBuffer());

  const withThumbnails = await preview(`${base}/article`);
  assert.ok(withThumbnails.body.thumbnails.image);
  hits = [];

  for (const query of ['', '&thumbnails=0', '&thumbnails=true', '&thumbnails=', '&thumbnails=1&thumbnails=1', '&thumbnails[]=1', '&thumbnails=11']) {
    const { status, body, text, log } = await preview(`${base}/article`, query);
    assert.equal(status, 200, query);
    assert.deepEqual(Object.keys(body), ['preview', 'previewStatus'], query);
    // Byte for byte what the route sent before: the two fields and nothing else.
    assert.equal(text, JSON.stringify({ preview: body.preview, previewStatus: 'fresh' }), query);
    assert.deepEqual(
      { ...body.preview, fetchedAt: null },
      { ...withThumbnails.body.preview, fetchedAt: null },
      query
    );
    assert.match(log, /outcome=preview_generated previewMs=\d+$/, query);
  }
  // Each call fetched the page afresh (no cache) and nothing else.
  assert.equal(hitCount('/article'), 7);
  assert.equal(hits.length, 7, hits.join(', '));

  // A failed fetch keeps its old shape too.
  const failed = await preview(`${base}/missing`, '');
  assert.deepEqual(failed.body, { preview: null, previewStatus: 'error', previewError: 'Page returned HTTP 404' });
});

test('falls back to /favicon.ico when the page declares no icon', async () => {
  routes['/plain'] = page('<title>Plain</title>');
  routes['/favicon.ico'] = serve(icoFile([
    { size: 16, data: icoBitmap(16, 32, [255, 0, 0, 255]) },
    { size: 32, data: icoBitmap(32, 32, [0, 0, 255, 255]) },
    { size: 48, data: icoBitmap(48, 32, [0, 255, 0, 255]) }
  ]), 'image/x-icon');

  const { body, log } = await preview(`${base}/plain`);
  assert.equal(body.preview.faviconUrl, null);
  assert.equal(body.thumbnails.image, null);
  assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [32, 32]);
  // The 32px entry (blue) was the one chosen.
  const { bytes } = await decoded(body.thumbnails.favicon, 'image/png');
  const pixel = await sharp(bytes).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...pixel.subarray(0, 4)], [0, 0, 255, 255]);
  assert.match(log, /image=none imageMs=\d+ favicon=ok faviconSource=fallback/);
});

test('a page with no preview data still gets an icon thumbnail', async () => {
  routes['/bare'] = page('<link rel="icon" href="/icon.png">');
  routes['/icon.png'] = serve(await solid(48, 48).png().toBuffer());

  const { body, log } = await preview(`${base}/bare`);
  assert.equal(body.preview, null);
  assert.equal(body.previewStatus, 'no_data');
  assert.equal(body.thumbnails.image, null);
  assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [32, 32]);
  assert.match(log, /outcome=preview_not_found .*favicon=ok faviconSource=declared/);

  // And without thumbnails=1 that page answers as it always did.
  const plain = await preview(`${base}/bare`, '');
  assert.equal(plain.text, '{"preview":null,"previewStatus":"no_data"}');
});

test('the fallback icon comes from the origin the page finally redirected to', async () => {
  routes['/moved'] = (req, res) => res.writeHead(302, { location: `http://elsewhere.test:${port}/landing` }).end();
  routes['/landing'] = page();
  routes['/favicon.ico'] = serve(icoFile([{ size: 32, data: await solid(32, 32).png().toBuffer() }]), 'image/x-icon');

  const { body } = await preview(`${base}/moved`);
  assert.equal(body.preview, null);
  assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [32, 32]);
  assert.deepEqual(hits.filter(hit => hit.endsWith('/favicon.ico')), ['elsewhere.test /favicon.ico']);
});

test('falls back to /favicon.ico when the declared icon cannot be used', async () => {
  routes['/favicon.ico'] = serve(icoFile([{ size: 32, data: icoBitmap(32, 24, [10, 20, 30]) }]), 'image/x-icon');
  // Missing, an SVG, and a host the bridge won't call.
  routes['/icon.svg'] = serve(SVG, 'image/svg+xml');
  for (const href of ['/gone.png', '/icon.svg', 'http://10.0.0.1/icon.png']) {
    thumbnailing.cache.clear();
    routes['/page'] = page('<title>Page</title>', `<link rel="icon" href="${href}">`);
    const { body, log } = await preview(`${base}/page`);
    assert.ok(body.thumbnails.favicon, href);
    assert.match(log, /favicon=ok faviconSource=fallback/, href);
    assert.equal(body.preview.faviconUrl, new URL(href, base).toString(), href);
  }
});

test('small images are not enlarged', async () => {
  routes['/small'] = page('<meta property="og:image" content="/small.png">', '<link rel="icon" href="/tiny.png">');
  routes['/small.png'] = serve(await solid(100, 50).png().toBuffer());
  routes['/tiny.png'] = serve(await solid(16, 16).png().toBuffer());

  const { body } = await preview(`${base}/small`);
  assert.deepEqual([body.thumbnails.image.width, body.thumbnails.image.height], [100, 50]);
  assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [16, 16]);
});

test('tall images fit inside 240x240, and WebP and GIF sources are accepted', async () => {
  const sources = {
    '/tall.webp': await solid(300, 900).webp().toBuffer(),
    '/tall.gif': await solid(300, 900).gif().toBuffer(),
    '/tall.png': await solid(300, 900).png().toBuffer()
  };
  for (const [path, bytes] of Object.entries(sources)) {
    // The header is wrong on purpose: only the bytes decide.
    routes[path] = serve(bytes, 'application/octet-stream');
    routes['/tall'] = page(`<meta property="og:image" content="${path}">`);
    thumbnailing.cache.clear();
    const { body } = await preview(`${base}/tall`);
    assert.deepEqual([body.thumbnails.image?.width, body.thumbnails.image?.height], [80, 240], path);
  }
});

test('AVIF and HEIF are not decoded: a tiny file can demand hundreds of megabytes', async () => {
  const avif = await solid(64, 64).avif().toBuffer();
  assert.equal(avif.toString('latin1', 4, 12), 'ftypavif');
  // Refused by the first bytes, and the loader behind them is switched off too.
  assert.equal(thumbnailing.sniffImageFormat(avif), null);
  thumbnailing.engine.get();
  await assert.rejects(sharp(avif).metadata(), /unsupported image format/);

  routes['/photo.avif'] = serve(avif, 'image/avif');
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/photo.avif">', '<link rel="icon" href="/photo.avif">');
  const { body, log } = await preview(`${base}/page`);
  assert.deepEqual(body.thumbnails, { image: null, favicon: null });
  assert.equal(body.thumbnailsStatus, 'complete');
  assert.match(log, /image=unsupported/);
});

test('an animated image yields a single still frame, and metadata is stripped', async () => {
  const frames = [await solid(300, 200, '#f00').png().toBuffer(), await solid(300, 200, '#00f').png().toBuffer()];
  const animated = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  routes['/anim.gif'] = serve(animated, 'image/gif');
  routes['/anim'] = page('<meta property="og:image" content="/anim.gif">');

  const anim = await preview(`${base}/anim`);
  assert.deepEqual([anim.body.thumbnails.image.width, anim.body.thumbnails.image.height], [240, 160]);
  const still = await decoded(anim.body.thumbnails.image, 'image/webp');
  assert.equal((await sharp(still.bytes, { animated: true }).metadata()).pages ?? 1, 1);

  const withExif = await solid(600, 400).withExif({ IFD0: { Copyright: 'someone private' } }).jpeg().toBuffer();
  assert.ok((await sharp(withExif).metadata()).exif);
  routes['/exif.jpg'] = serve(withExif, 'image/jpeg');
  routes['/exif'] = page('<meta property="og:image" content="/exif.jpg">');
  const exif = await preview(`${base}/exif`);
  const stripped = await decoded(exif.body.thumbnails.image, 'image/webp');
  assert.equal(stripped.metadata.exif, undefined);
  assert.equal(stripped.metadata.icc, undefined);
  assert.equal(stripped.metadata.xmp, undefined);
});

// ---- The page fetch decides whether anything else is fetched ----

test('a page that fails for good gets null thumbnails, "complete", and no further requests', async () => {
  const missing = await preview(`${base}/missing`);
  assert.deepEqual(missing.body, {
    preview: null,
    previewStatus: 'error',
    previewError: 'Page returned HTTP 404',
    thumbnails: { image: null, favicon: null },
    thumbnailsStatus: 'complete'
  });
  assert.deepEqual(hits, ['thumbs.test /missing']);
  assert.match(missing.log, /outcome=preview_failed .*thumbs=complete image=no_page imageMs=0 favicon=no_page faviconMs=0$/);

  for (const status of [400, 401, 403, 410, 451]) {
    routes['/refused'] = (req, res) => res.writeHead(status, { 'content-type': 'text/html' }).end('<title>No</title>');
    const refused = await preview(`${base}/refused`);
    assert.equal(refused.body.previewError, `Page returned HTTP ${status}`);
    assert.equal(refused.body.thumbnailsStatus, 'complete', status);
  }
  assert.equal(hitCount('/favicon.ico'), 0);
});

test('a page on a private host, by name or by redirect, is "complete" and nothing else is fetched', async () => {
  routes['/favicon.ico'] = serve(await solid(32, 32).png().toBuffer());
  const byName = await preview(`http://private.test:${port}/`);
  assert.equal(byName.body.previewError, 'URL host is not reachable from the proxy');
  assert.deepEqual(byName.body.thumbnails, { image: null, favicon: null });
  assert.equal(byName.body.thumbnailsStatus, 'complete');

  routes['/bounce'] = (req, res) => res.writeHead(302, { location: `http://localhost:${port}/secret` }).end();
  const byRedirect = await preview(`${base}/bounce`);
  assert.equal(byRedirect.body.previewError, 'URL host is not reachable from the proxy');
  assert.equal(byRedirect.body.thumbnailsStatus, 'complete');
  assert.match(byRedirect.log, /image=no_page imageMs=0 favicon=no_page/);
  // Not even the public origin that did the redirecting is asked for an icon.
  assert.deepEqual(hits, ['thumbs.test /bounce']);
});

test('a page that fails in passing is "transient"', async () => {
  for (const status of [500, 502, 503, 429, 408]) {
    routes['/later'] = (req, res) => res.writeHead(status, { 'content-type': 'text/html' }).end('<title>Later</title>');
    const later = await preview(`${base}/later`);
    assert.equal(later.body.previewError, `Page returned HTTP ${status}`);
    assert.deepEqual(later.body.thumbnails, { image: null, favicon: null });
    assert.equal(later.body.thumbnailsStatus, 'transient', status);
  }
  routes['/dropped'] = (req, res) => res.destroy();
  const dropped = await preview(`${base}/dropped`);
  assert.equal(dropped.body.previewError, 'Could not fetch the page');
  assert.equal(dropped.body.thumbnailsStatus, 'transient');

  routes['/stall'] = (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html><head><title>Slow'); };
  const stalled = await preview(`${base}/stall`);
  assert.equal(stalled.body.previewError, 'Preview fetch timed out');
  assert.equal(stalled.body.thumbnailsStatus, 'transient');
  assert.match(stalled.log, /thumbs=transient image=no_page/);
  assert.equal(hitCount('/favicon.ico'), 0);
});

test('a link that is not a page (a PDF, an image) still gets its site\'s icon', async () => {
  routes['/favicon.ico'] = serve(icoFile([{ size: 32, data: icoBitmap(32, 32, [0, 0, 255, 255]) }]), 'image/x-icon');
  routes['/paper.pdf'] = serve(Buffer.from('%PDF-1.7'), 'application/pdf');
  routes['/photo.png'] = serve(await solid(800, 600).png().toBuffer());

  for (const path of ['/paper.pdf', '/photo.png']) {
    thumbnailing.cache.clear();
    hits = [];
    const { body, log } = await preview(`${base}${path}`);
    assert.equal(body.preview, null, path);
    assert.equal(body.previewStatus, 'error', path);
    assert.equal(body.previewError, 'Preview response is not HTML', path);
    assert.equal(body.thumbnails.image, null, path);
    assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [32, 32], path);
    assert.equal(body.thumbnailsStatus, 'complete', path);
    assert.deepEqual(hits, [`thumbs.test ${path}`, 'thumbs.test /favicon.ico'], path);
    assert.match(log, /outcome=preview_failed .*thumbs=complete image=none imageMs=\d+ favicon=ok faviconSource=fallback/, path);
  }

  // The icon comes from wherever the link finally led.
  thumbnailing.cache.clear();
  hits = [];
  routes['/moved.pdf'] = (req, res) => res.writeHead(302, { location: `http://elsewhere.test:${port}/paper.pdf` }).end();
  const moved = await preview(`${base}/moved.pdf`);
  assert.ok(moved.body.thumbnails.favicon);
  assert.deepEqual(hits, ['thumbs.test /moved.pdf', 'elsewhere.test /paper.pdf', 'elsewhere.test /favicon.ico']);

  // No icon there is a settled answer too; a non-HTML error page is just a failed page.
  thumbnailing.cache.clear();
  routes['/favicon.ico'] = undefined;
  const bare = await preview(`${base}/paper.pdf`);
  assert.deepEqual(bare.body.thumbnails, { image: null, favicon: null });
  assert.equal(bare.body.thumbnailsStatus, 'complete');
  hits = [];
  routes['/gone.pdf'] = (req, res) => res.writeHead(404, { 'content-type': 'application/pdf' }).end();
  const gone = await preview(`${base}/gone.pdf`);
  assert.equal(gone.body.thumbnailsStatus, 'complete');
  assert.deepEqual(hits, ['thumbs.test /gone.pdf']);

  // Without thumbnails=1 a non-HTML link answers as it always did, and fetches nothing more.
  hits = [];
  const plain = await preview(`${base}/paper.pdf`, '');
  assert.deepEqual(plain.body, { preview: null, previewStatus: 'error', previewError: 'Preview response is not HTML' });
  assert.deepEqual(hits, ['thumbs.test /paper.pdf']);
});

test('the target URL and Authorization header are checked as before', async () => {
  const privateTarget = await preview('http://127.0.0.2/');
  assert.equal(privateTarget.status, 400);
  const noAuth = await preview(`${base}/article`, '&thumbnails=1', {});
  assert.equal(noAuth.status, 401);
  assert.deepEqual(noAuth.body, { error: 'Authorization header required' });
  assert.equal(hits.length, 0);
});

// ---- Security: where an image may be fetched from ----

test('refuses an image whose URL names a private host, without calling it', async () => {
  routes['/secret.png'] = serve(await solid(50, 50).png().toBuffer());
  routes['/favicon.ico'] = routes['/secret.png'];
  for (const imageUrl of [
    `http://localhost:${port}/secret.png`,
    `http://127.0.0.2:${port}/secret.png`,
    'http://10.0.0.1/secret.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/secret.png',
    'http://[::ffff:10.0.0.1]/secret.png',
    'http://0x0a.1/secret.png'
  ]) {
    thumbnailing.cache.clear();
    routes['/page'] = page('<title>Page</title>', `<meta property="og:image" content="${imageUrl}">`);
    const startedAt = Date.now();
    const { body, log } = await preview(`${base}/page`);
    assert.equal(body.thumbnails.image, null, imageUrl);
    assert.match(log, /image=blocked/, imageUrl);
    assert.ok(Date.now() - startedAt < 1500, `${imageUrl} should be refused at once`);
    // The preview itself is untouched by the refusal.
    assert.equal(body.preview.imageUrl, new URL(imageUrl).toString(), imageUrl);
    assert.equal(body.previewStatus, 'fresh', imageUrl);
  }
  assert.equal(hitCount('/secret.png'), 0);
});

test('refuses an image whose hostname resolves to a private address', async () => {
  routes['/page'] = page('<title>Page</title>', `<meta property="og:image" content="http://private.test:${port}/secret.png">`);
  const startedAt = Date.now();
  const { body, log } = await preview(`${base}/page`);
  assert.equal(body.thumbnails.image, null);
  assert.match(log, /image=blocked/);
  assert.ok(Date.now() - startedAt < 1500);
});

test('refuses an image that redirects from a public host to a private one', async () => {
  routes['/secret.png'] = serve(await solid(50, 50).png().toBuffer());
  const redirects = {
    '/to-localhost.png': `http://localhost:${port}/secret.png`,
    '/to-private-ip.png': `http://127.0.0.2:${port}/secret.png`,
    '/to-private-name.png': `http://private.test:${port}/secret.png`,
    '/to-metadata.png': 'http://169.254.169.254/latest/meta-data/'
  };
  for (const [path, location] of Object.entries(redirects)) {
    routes[path] = (req, res) => res.writeHead(302, { location }).end();
    routes['/page'] = page('<title>Page</title>', `<meta property="og:image" content="${path}">`, `<link rel="icon" href="${path}">`);
    thumbnailing.cache.clear();
    const { body, log } = await preview(`${base}/page`);
    assert.equal(body.thumbnails.image, null, path);
    assert.equal(body.thumbnails.favicon, null, path);
    assert.match(log, /thumbs=complete image=blocked/, path);
    // Wanted as image and as icon, asked for once.
    assert.equal(hitCount(path), 1, path);
  }
  assert.equal(hitCount('/secret.png'), 0);
});

test('follows at most three redirects for an image', async () => {
  const image = await solid(50, 50).png().toBuffer();
  for (let i = 1; i <= 4; i += 1) {
    routes[`/hop${i}`] = (req, res) => res.writeHead(302, { location: i === 1 ? '/final.png' : `/hop${i - 1}` }).end();
  }
  routes['/final.png'] = serve(image);

  routes['/page'] = page('<meta property="og:image" content="/hop3">');
  const three = await preview(`${base}/page`);
  assert.ok(three.body.thumbnails.image);

  thumbnailing.cache.clear();
  routes['/page'] = page('<meta property="og:image" content="/hop4">');
  const four = await preview(`${base}/page`);
  assert.equal(four.body.thumbnails.image, null);
});

test('only http and https image links are fetched', async () => {
  for (const imageUrl of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'ftp://thumbs.test/x.png', 'javascript:alert(1)']) {
    thumbnailing.cache.clear();
    routes['/page'] = page('<title>Page</title>', `<meta property="og:image" content="${imageUrl}">`, `<link rel="icon" href="${imageUrl}">`);
    const { body, log } = await preview(`${base}/page`);
    assert.equal(body.preview.imageUrl, null, imageUrl);
    assert.equal(body.thumbnails.image, null, imageUrl);
    assert.match(log, /image=none/, imageUrl);
  }
});

// ---- Security: how much is read, and for how long ----

test('gives up on an image that declares itself too large, without reading it', async () => {
  const declared = 64 * 1024 * 1024;
  let sent = 0;
  routes['/huge.png'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': declared });
    const chunk = Buffer.alloc(64 * 1024);
    const pump = () => {
      while (!res.destroyed && sent < declared) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
    };
    pump();
  };
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/huge.png">');
  const { body, log } = await preview(`${base}/page`);
  assert.equal(body.thumbnails.image, null);
  assert.match(log, /image=too_large/);
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
  assert.ok(sent < declared / 2, `the body should not have been read, but ${sent} bytes were sent`);
});

test('stops reading an endless image at 2 MB and an endless icon at 512 KB', async () => {
  const sent = { '/endless.png': 0, '/endless.ico': 0 };
  const endless = (req, res) => {
    // No Content-Length, and a real PNG signature, so only the cap stops it.
    res.writeHead(200, { 'content-type': 'image/png' });
    res.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const chunk = Buffer.alloc(16 * 1024, 1);
    const pump = () => {
      while (!res.destroyed) {
        sent[req.url] += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
    };
    pump();
  };
  routes['/endless.png'] = endless;
  routes['/endless.ico'] = endless;
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/endless.png">', '<link rel="icon" href="/endless.ico">');

  const startedAt = Date.now();
  const { body, log } = await preview(`${base}/page`);
  assert.equal(body.thumbnails.image, null);
  assert.equal(body.thumbnails.favicon, null);
  assert.match(log, /image=too_large/);
  assert.ok(Date.now() - startedAt < 3000, 'the cap, not the deadline, should end the read');
  assert.ok(await allClosed(), 'expected the bridge to close the connections');
  // Socket buffers let a server get ahead of the reader, but not by much.
  assert.ok(sent['/endless.png'] < 2 * 1024 * 1024 + 4 * 1024 * 1024, `image server sent ${sent['/endless.png']} bytes`);
  assert.ok(sent['/endless.ico'] < 512 * 1024 + 4 * 1024 * 1024, `icon server sent ${sent['/endless.ico']} bytes`);
});

test('a compressed body is capped by its decompressed size', async () => {
  const zlib = require('node:zlib');
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024));
  assert.ok(bomb.length < 64 * 1024);
  routes['/bomb.png'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip', 'content-length': bomb.length });
    res.end(bomb);
  };
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/bomb.png">');
  const { body, log } = await preview(`${base}/page`);
  assert.equal(body.thumbnails.image, null);
  assert.match(log, /image=too_large/);
});

test('a slow-drip image is dropped at the deadline; the icon still arrives', async () => {
  const png = await solid(400, 400).png({ compressionLevel: 0 }).toBuffer();
  let timer;
  routes['/drip.png'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    let at = 0;
    // A byte every 50 ms never trips a socket-idle timeout.
    timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      res.write(png.subarray(at, at + 1));
      at += 1;
    }, 50);
  };
  routes['/icon.png'] = serve(await solid(32, 32).png().toBuffer());
  routes['/page'] = page('<title>Slow</title>', '<meta property="og:image" content="/drip.png">', '<link rel="icon" href="/icon.png">');

  const startedAt = Date.now();
  const { body, log } = await preview(`${base}/page`);
  const elapsed = Date.now() - startedAt;
  clearInterval(timer);
  assert.equal(body.preview.title, 'Slow');
  assert.equal(body.previewStatus, 'fresh');
  assert.equal(body.thumbnails.image, null);
  assert.ok(body.thumbnails.favicon);
  assert.match(log, /image=timeout imageMs=4\d\d\d favicon=ok/);
  assert.ok(elapsed >= thumbnailing.settings.phaseTimeoutMs - 100 && elapsed < thumbnailing.settings.phaseTimeoutMs + 1500, `took ${elapsed}ms`);
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
  assert.equal(body.thumbnailsStatus, 'transient');
  await settled();

  // A timeout is only remembered for a short while.
  const entry = thumbnailing.cache.entries.get(`image ${base}/drip.png`);
  assert.equal(entry.value.outcome, 'timeout');
  const ttl = entry.expiresAt - Date.now();
  assert.ok(ttl > 0 && ttl <= thumbnailing.settings.cacheRetryTtlMs, `ttl ${ttl}`);
});

test('an image server that never answers is dropped at the deadline', async () => {
  routes['/silent.png'] = () => { /* accept the request and say nothing */ };
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/silent.png">');
  const startedAt = Date.now();
  const { body, log } = await preview(`${base}/page`);
  assert.equal(body.thumbnails.image, null);
  assert.match(log, /thumbs=transient image=timeout/);
  assert.ok(Date.now() - startedAt < thumbnailing.settings.phaseTimeoutMs + 1500);
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
});

// ---- Security: what is decoded ----

test('content that only claims to be an image is refused', async () => {
  const gif = await solid(20, 20).gif().toBuffer();
  const fakes = {
    html: Buffer.from('<!doctype html><html><body><img src="x"></body></html>'),
    svg: SVG,
    'svg with a BOM and whitespace': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\n  '), SVG]),
    'gzipped svg': require('node:zlib').gzipSync(SVG),
    'svg behind a GIF signature': Buffer.concat([Buffer.from('GIF89a  '), SVG]),
    'svg behind a RIFF signature': Buffer.concat([Buffer.from('RIFF    WEBP'), SVG]),
    'a GIF header and nothing else': gif.subarray(0, 10),
    'a PNG signature and noise': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]),
    pdf: Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'),
    tiff: await solid(20, 20).tiff().toBuffer(),
    bmp: Buffer.concat([Buffer.from('BM'), Buffer.alloc(60)]),
    empty: Buffer.alloc(0)
  };
  for (const [name, bytes] of Object.entries(fakes)) {
    routes['/fake.png'] = serve(bytes, 'image/png');
    routes['/favicon.ico'] = serve(bytes, 'image/x-icon');
    routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/fake.png">');
    thumbnailing.cache.clear();
    const { body, log } = await preview(`${base}/page`);
    assert.deepEqual(body.thumbnails, { image: null, favicon: null }, name);
    assert.match(log, /thumbs=complete image=(unsupported|undecodable) /, name);
    assert.equal(body.previewStatus, 'fresh', name);
  }
});

test('the first bytes decide the format, and SVG is never one of them', async () => {
  const { sniffImageFormat } = thumbnailing;
  // Behind the sniffing, libvips itself has every loader but ours switched off.
  await assert.rejects(sharp(SVG).metadata(), /unsupported image format/);
  await assert.rejects(sharp(await solid(20, 20).tiff().toBuffer()).metadata(), /unsupported image format/);
  assert.equal(sniffImageFormat(SVG), null);
  assert.equal(sniffImageFormat(Buffer.from('<?xml version="1.0"?><svg/>')), null);
  assert.equal(sniffImageFormat(Buffer.from('<html>')), null);
  assert.equal(sniffImageFormat(Buffer.alloc(0)), null);
  assert.equal(sniffImageFormat(Buffer.from([0xff, 0xd8])), null);
  assert.equal(sniffImageFormat(Buffer.from('RIFF\0\0\0\0WAVE')), null);
  // No ISO media file is an image here: not AVIF, not HEIC, not MP4.
  assert.equal(sniffImageFormat(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic')), null);
  assert.equal(sniffImageFormat(Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0isommp42')), null);
  assert.equal(sniffImageFormat(Buffer.from('\0\0\0\x1cftypmif1\0\0\0\0mif1avifmiaf')), null);
  assert.equal(sniffImageFormat(Buffer.from('\0\0\0\x10ftypavif')), null);
  assert.equal(sniffImageFormat(Buffer.from([0, 0, 1, 0])), 'ico');
  assert.equal(sniffImageFormat(Buffer.from([0, 0, 2, 0])), null); // a cursor file
});

test('an .ico file is only accepted as an icon, never as the preview image', async () => {
  const ico = icoFile([{ size: 32, data: icoBitmap(32, 32, [1, 2, 3, 255]) }]);
  routes['/image.ico'] = serve(ico, 'image/png');
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/image.ico">', '<link rel="icon" href="/image.ico">');
  const { body, log } = await preview(`${base}/page`);
  assert.equal(body.thumbnails.image, null);
  assert.ok(body.thumbnails.favicon);
  assert.match(log, /image=unsupported/);
  assert.equal(hitCount('/image.ico'), 1);
});

test('images with decompression-bomb dimensions are refused from their header', async () => {
  // Tiny files, enormous canvases: past the pixel limits for each kind.
  const { image, favicon } = thumbnailing.settings.kinds;
  const hugeImage = await sharp({ create: { width: 3200, height: 3200, channels: 3, background: '#123' } }).png().toBuffer();
  const hugeIcon = await sharp({ create: { width: 1500, height: 1500, channels: 3, background: '#123' } }).png().toBuffer();
  assert.ok(hugeImage.length < image.maxBytes);
  assert.ok(3200 * 3200 > image.maxPixels);
  assert.ok(1500 * 1500 > favicon.maxPixels && 1500 * 1500 < image.maxPixels);
  routes['/huge.png'] = serve(hugeImage);
  routes['/huge-icon.png'] = serve(hugeIcon);
  // The same icon wrapped in an .ico must not get round the limit.
  routes['/favicon.ico'] = serve(icoFile([{ size: 256, data: hugeIcon }]), 'image/x-icon');
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/huge.png">', '<link rel="icon" href="/huge-icon.png">');

  let decodes = 0;
  const restore = withSharp(pipeline => {
    const realToBuffer = pipeline.toBuffer.bind(pipeline);
    pipeline.toBuffer = (...args) => { decodes += 1; return realToBuffer(...args); };
    return pipeline;
  });
  try {
    const { body, log } = await preview(`${base}/page`);
    assert.deepEqual(body.thumbnails, { image: null, favicon: null });
    assert.equal(body.thumbnailsStatus, 'complete');
    assert.match(log, /image=too_large imageMs=\d+ favicon=too_large/);
    assert.equal(decodes, 0, 'refused from the header, without decoding a pixel');
  } finally {
    restore();
  }

  // The icon-sized limit applies to icons only: this one is fine as an image.
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/huge-icon.png">');
  thumbnailing.cache.clear();
  const ok = await preview(`${base}/page`);
  assert.deepEqual([ok.body.thumbnails.image.width, ok.body.thumbnails.image.height], [240, 240]);
});

test('the limit is on decoded size, so a 16-bit image is allowed half the area', async () => {
  const { image } = thumbnailing.settings.kinds;
  const side = 2500;
  assert.ok(side * side < image.maxPixels);
  assert.ok(side * side * 4 <= image.maxDecodedBytes && side * side * 4 * 2 > image.maxDecodedBytes);
  const deep = () => sharp({ create: { width: side, height: side, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } });
  routes['/eight.png'] = serve(await deep().png().toBuffer());
  routes['/sixteen.png'] = serve(await deep().toColourspace('rgb16').png().toBuffer());
  assert.equal((await sharp(await deep().toColourspace('rgb16').png().toBuffer()).metadata()).depth, 'ushort');

  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/eight.png">');
  const eight = await preview(`${base}/page`);
  assert.deepEqual([eight.body.thumbnails.image.width, eight.body.thumbnails.image.height], [240, 240]);

  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/sixteen.png">');
  const sixteen = await preview(`${base}/page`);
  assert.equal(sixteen.body.thumbnails.image, null);
  assert.match(sixteen.log, /image=too_large/);
});

test('a corrupt or truncated image is refused, not half-decoded', async () => {
  const jpeg = await sharp({ create: { width: 800, height: 800, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 800, height: 800, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();
  for (const [name, bytes] of Object.entries({ jpeg: jpeg.subarray(0, jpeg.length >> 1), png: png.subarray(0, png.length >> 1) })) {
    routes['/cut'] = serve(bytes);
    routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/cut">');
    thumbnailing.cache.clear();
    const { body, log } = await preview(`${base}/page`);
    assert.equal(body.thumbnails.image, null, name);
    assert.match(log, /image=undecodable/, name);
  }
});

// ---- Security: the ICO parser ----

test('lists the ICO entries best suited to 32px, bitmap or embedded PNG', async () => {
  const { pickIcoImages } = thumbnailing;
  const png48 = await solid(48, 48).png().toBuffer();

  const mixed = pickIcoImages(icoFile([
    { size: 256, data: icoBitmap(64, 32, [9, 9, 9, 255]) },
    { size: 16, data: icoBitmap(16, 32, [1, 1, 1, 255]) },
    { size: 48, data: png48 }
  ]), 32);
  assert.ok(mixed[0].png.equals(png48), 'the smallest entry of at least 32px comes first');
  assert.deepEqual([mixed[1].raw.width, mixed[2].raw.width], [64, 16], 'then larger ones, then smaller');

  const onlySmall = pickIcoImages(icoFile([
    { size: 16, data: icoBitmap(16, 32, [1, 1, 1, 255]) },
    { size: 24, data: icoBitmap(24, 32, [2, 2, 2, 255]) }
  ]), 32);
  assert.deepEqual([onlySmall[0].raw.width, onlySmall[0].raw.height], [24, 24]);

  // Pixels come out as RGBA, top row first.
  const bitmap = icoBitmap(2, 32, [10, 20, 30, 40]);
  bitmap.writeUInt8(99, 40 + 8); // blue of the stored second row = image's top-left
  const [{ raw }] = pickIcoImages(icoFile([{ size: 2, data: bitmap }]), 32);
  assert.deepEqual([...raw.rgba.subarray(0, 4)], [10, 20, 99, 40]);
  assert.deepEqual([...raw.rgba.subarray(8, 12)], [10, 20, 30, 40]);

  // 24-bit entries are opaque except where the mask says otherwise.
  const masked = icoBitmap(2, 24, [10, 20, 30]);
  masked[40 + 16] = 0x80; // mask bit for the stored first row's first pixel = bottom-left
  const [opaque] = pickIcoImages(icoFile([{ size: 2, bitCount: 24, data: masked }]), 32);
  assert.deepEqual([...opaque.raw.rgba], [10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 0, 10, 20, 30, 255]);

  // A 32-bit entry with an all-zero alpha channel is not left invisible.
  const [noAlpha] = pickIcoImages(icoFile([{ size: 2, data: icoBitmap(2, 32, [5, 6, 7, 0]) }]), 32);
  assert.deepEqual([...noAlpha.raw.rgba.subarray(0, 4)], [5, 6, 7, 255]);

  // An entry that can't be decoded is passed over, and no more than three
  // entries are offered however many the file has.
  const compressed = icoBitmap(32, 32, [0, 0, 0, 255]);
  compressed.writeUInt32LE(1, 16);
  const passedOver = pickIcoImages(icoFile([{ size: 32, data: compressed }, { size: 64, data: png48 }]), 32);
  assert.equal(passedOver.length, 1);
  assert.ok(passedOver[0].png.equals(png48));
  const many = pickIcoImages(icoFile([16, 24, 32, 48, 64].map(size => ({ size, data: icoBitmap(size, 32, [1, 1, 1, 255]) }))), 32);
  assert.deepEqual(many.map(image => image.raw.width), [32, 48, 64]);
});

test('palette ICO bitmaps (1-, 4- and 8-bit) are decoded with their mask', async () => {
  const { pickIcoImages } = thumbnailing;
  const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [9, 8, 7]];

  for (const bitCount of [1, 4, 8]) {
    const colours = bitCount === 1 ? 2 : 4;
    const indexAt = (x, y) => (x + y) % colours;
    const size = 5; // not a multiple of the pixels in a byte, so rows are padded
    const [{ raw }] = pickIcoImages(icoFile([{
      size,
      bitCount,
      data: icoPaletteBitmap(size, bitCount, palette, indexAt, { transparent: [[4, 0]] })
    }]), 32);
    assert.deepEqual([raw.width, raw.height], [size, size], `${bitCount}-bit`);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const alpha = x === 4 && y === 0 ? 0 : 255;
        assert.deepEqual([...raw.rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)], [...palette[indexAt(x, y)], alpha], `${bitCount}-bit pixel ${x},${y}`);
      }
    }
  }

  // A short colour table is honoured, and an index beyond it is black, not
  // a read past the table.
  const short = icoPaletteBitmap(4, 8, palette, (x, y) => (x === 0 && y === 0 ? 200 : 1), { coloursUsed: 2 });
  const [{ raw: shortRaw }] = pickIcoImages(icoFile([{ size: 4, bitCount: 8, data: short }]), 32);
  assert.deepEqual([...shortRaw.rgba.subarray(0, 8)], [0, 0, 0, 255, 0, 255, 0, 255]);

  // Through the route: an old-style 8-bit favicon.ico now gives a thumbnail.
  routes['/favicon.ico'] = serve(icoFile([{ size: 32, bitCount: 8, data: icoPaletteBitmap(32, 8, palette, () => 2) }]), 'image/x-icon');
  routes['/page'] = page('<title>Page</title>');
  const { body } = await preview(`${base}/page`);
  assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [32, 32]);
  const { bytes } = await decoded(body.thumbnails.favicon, 'image/png');
  assert.deepEqual([...(await sharp(bytes).ensureAlpha().raw().toBuffer()).subarray(0, 4)], [0, 0, 255, 255]);
});

test('an .ico whose best embedded PNG is broken falls back to its other entries', async () => {
  const brokenPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
  const good = await solid(48, 48, '#00f').png().toBuffer();
  routes['/page'] = page('<title>Page</title>');

  routes['/favicon.ico'] = serve(icoFile([{ size: 32, data: brokenPng }, { size: 48, data: good }]), 'image/x-icon');
  const second = await preview(`${base}/page`);
  assert.deepEqual([second.body.thumbnails.favicon?.width, second.body.thumbnails.favicon?.height], [32, 32]);
  assert.equal(second.body.thumbnailsStatus, 'complete');

  // The attempts are capped: a good entry behind three bad ones is not reached.
  thumbnailing.cache.clear();
  routes['/favicon.ico'] = serve(icoFile([
    { size: 32, data: brokenPng }, { size: 40, data: brokenPng }, { size: 44, data: brokenPng }, { size: 48, data: good }
  ]), 'image/x-icon');
  const capped = await preview(`${base}/page`);
  assert.equal(capped.body.thumbnails.favicon, null);
  assert.match(capped.log, /favicon=undecodable/);
});

test('malformed ICO files are refused without reading out of range', async () => {
  const { pickIcoImages } = thumbnailing;
  const good = icoBitmap(32, 32, [1, 2, 3, 255]);
  const withHeader = (bitmap, change) => {
    const copy = Buffer.from(bitmap);
    change(copy);
    return icoFile([{ size: 32, data: copy }]);
  };
  const countOf = (count, length) => {
    const file = Buffer.alloc(length);
    file.writeUInt16LE(1, 2);
    file.writeUInt16LE(count, 4);
    return file;
  };
  const palette8 = icoPaletteBitmap(32, 8, [[1, 2, 3]], () => 0);
  const malformed = {
    'empty': Buffer.alloc(0),
    'header only': Buffer.from([0, 0, 1, 0, 1, 0]),
    'no entries': countOf(0, 64),
    'more entries than the file holds': countOf(4, 6 + 16 * 2),
    'an absurd entry count': countOf(65535, 6 + 16 * 65535),
    'a cursor, not an icon': Buffer.concat([Buffer.from([0, 0, 2, 0, 1, 0]), Buffer.alloc(16 + 40)]),
    'offset past the end': icoFile([{ size: 32, data: good, offset: 1 << 20 }]),
    'offset at 4 GB': icoFile([{ size: 32, data: good, offset: 0xffffffff }]),
    'offset inside the directory': icoFile([{ size: 32, data: good, offset: 0 }]),
    'length past the end': icoFile([{ size: 32, data: good, length: good.length + 1 }]),
    'length of 4 GB': icoFile([{ size: 32, data: good, length: 0xffffffff }]),
    'zero length': icoFile([{ size: 32, data: good, length: 0 }]),
    'entry too short for a bitmap header': icoFile([{ size: 32, data: good.subarray(0, 39) }]),
    'bitmap header size past the entry': withHeader(good, b => b.writeUInt32LE(0x7fffffff, 0)),
    'bitmap header size too small': withHeader(good, b => b.writeUInt32LE(12, 0)),
    'bitmap wider than its data': withHeader(good, b => b.writeInt32LE(200, 4)),
    'bitmap taller than its data': withHeader(good, b => b.writeInt32LE(400, 8)),
    'bitmap dimensions past 256': withHeader(Buffer.concat([good, Buffer.alloc(16)]), b => { b.writeInt32LE(100000, 4); b.writeInt32LE(200000, 8); }),
    'negative width': withHeader(good, b => b.writeInt32LE(-32, 4)),
    'negative height': withHeader(good, b => b.writeInt32LE(-64, 8)),
    'zero width': withHeader(good, b => b.writeInt32LE(0, 4)),
    'odd doubled height': withHeader(good, b => b.writeInt32LE(63, 8)),
    'compressed bitmap': withHeader(good, b => b.writeUInt32LE(3, 16)),
    '16-bit bitmap': withHeader(good, b => b.writeUInt16LE(16, 14)),
    'zero bit depth': withHeader(good, b => b.writeUInt16LE(0, 14)),
    'pixel rows cut short': icoFile([{ size: 32, data: good.subarray(0, 40 + 32 * 4 * 10) }]),
    'colour table larger than the depth allows': withHeader(palette8, b => b.writeUInt32LE(257, 32)),
    'colour table of 4 billion entries': withHeader(palette8, b => b.writeUInt32LE(0xffffffff, 32)),
    'colour table running past the entry': icoFile([{ size: 32, bitCount: 8, data: palette8.subarray(0, 40 + 100) }]),
    'palette pixels cut short': icoFile([{ size: 32, bitCount: 8, data: palette8.subarray(0, 40 + 1024 + 32 * 10) }])
  };
  for (const [name, file] of Object.entries(malformed)) {
    assert.deepEqual(pickIcoImages(file, 32), [], name);
  }

  // A bitmap whose mask is missing is still decoded, as opaque.
  const [noMask] = pickIcoImages(icoFile([{ size: 32, bitCount: 24, data: icoBitmap(32, 24, [1, 2, 3]).subarray(0, 40 + 96 * 32) }]), 32);
  assert.equal(noMask.raw.rgba[3], 255);

  // Through the route, a malformed icon is just a missing thumbnail.
  routes['/favicon.ico'] = serve(malformed['offset past the end'], 'image/x-icon');
  routes['/page'] = page('<title>Page</title>');
  const { status, body, log } = await preview(`${base}/page`);
  assert.equal(status, 200);
  assert.equal(body.thumbnails.favicon, null);
  assert.match(log, /favicon=unsupported/);

  // An embedded "PNG" that isn't one fails in the decoder, not the parser.
  const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), SVG]);
  routes['/favicon.ico'] = serve(icoFile([{ size: 32, data: fakePng }]), 'image/x-icon');
  thumbnailing.cache.clear();
  const embedded = await preview(`${base}/page`);
  assert.equal(embedded.body.thumbnails.favicon, null);
  assert.match(embedded.log, /favicon=undecodable/);
});

test('random bytes after an ICO header never throw', () => {
  const { pickIcoImages } = thumbnailing;
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  let decodedSome = 0;
  for (let i = 0; i < 5000; i += 1) {
    const file = Buffer.alloc(6 + (random() % 400));
    for (let at = 0; at < file.length; at += 1) file[at] = random() & (random() % 3 ? 0x03 : 0xff);
    file.writeUInt16LE(0, 0);
    file.writeUInt16LE(1, 2);
    file.writeUInt16LE(1 + (random() % 3), 4);
    if (file.length > 80 && i % 2) {
      // Half the time, a plausible entry and header, so the pixel loops run.
      file.writeUInt32LE(file.length - 22, 6 + 8);
      file.writeUInt32LE(22, 6 + 12);
      file.writeUInt32LE(40, 22);
      file.writeInt32LE(1 + (random() % 6), 26);
      file.writeInt32LE(2 * (1 + (random() % 6)), 30);
      file.writeUInt16LE([1, 4, 8, 24, 32][random() % 5], 36);
      file.writeUInt32LE(0, 38);
    }
    for (const image of pickIcoImages(file, 32)) {
      if (image.raw) {
        decodedSome += 1;
        assert.equal(image.raw.rgba.length, image.raw.width * image.raw.height * 4);
      }
    }
  }
  assert.ok(decodedSome > 100, `only ${decodedSome} bitmaps were decoded`);
});

// ---- Which icons are tried ----

test('a declared raster icon is used when the preferred icon is an SVG or a mask icon', async () => {
  routes['/icon-32.png'] = serve(await solid(32, 32).png().toBuffer());
  routes['/icon.svg'] = serve(SVG, 'image/svg+xml');
  // No /favicon.ico: only the page's own PNG can succeed.
  const heads = {
    'svg ranked first by type': ['<link rel="icon" type="image/svg+xml" href="/icon.svg">', '<link rel="icon" href="/icon-32.png">'],
    'mask icon ranked first': ['<link rel="mask-icon" href="/icon.svg" color="#000">', '<link rel="icon" href="/icon-32.png">'],
    'svg by extension only': ['<link rel="icon" href="/icon.svg?v=2">', '<link rel="shortcut icon" href="/icon-32.png">']
  };
  for (const [name, tags] of Object.entries(heads)) {
    thumbnailing.cache.clear();
    hits = [];
    routes['/page'] = page('<title>Page</title>', ...tags);
    const { body, log } = await preview(`${base}/page`);
    assert.deepEqual([body.thumbnails.favicon?.width, body.thumbnails.favicon?.height], [32, 32], name);
    assert.match(log, /favicon=ok faviconSource=declared/, name);
    // What existing callers see is unchanged: still the SVG.
    assert.ok(body.preview.faviconUrl.startsWith(`${base}/icon.svg`), name);
    assert.equal(hitCount('/icon.svg'), 0, `${name}: the SVG is not even fetched`);
    assert.equal(hitCount('/favicon.ico'), 0, name);
  }
});

test('up to three declared icons are tried, in order, before /favicon.ico', async () => {
  routes['/c.png'] = serve(await solid(40, 40).png().toBuffer());
  routes['/page'] = page(
    '<title>Page</title>',
    '<link rel="icon" href="/a.png">',
    '<link rel="apple-touch-icon" href="/touch.png">',
    '<link rel="icon" href="/a.png">',
    '<link rel="icon" type="image/png" href="/typed.png">',
    '<link rel="icon" href="/d.png">'
  );
  // Order of preference: apple-touch-icon, typed PNG, then plain icons.
  const missing = await preview(`${base}/page`);
  assert.deepEqual(hits.slice(1), ['thumbs.test /touch.png', 'thumbs.test /typed.png', 'thumbs.test /a.png', 'thumbs.test /favicon.ico']);
  assert.equal(missing.body.thumbnails.favicon, null);
  assert.equal(missing.body.thumbnailsStatus, 'complete');

  thumbnailing.cache.clear();
  hits = [];
  routes['/a.png'] = routes['/c.png'];
  const third = await preview(`${base}/page`);
  assert.ok(third.body.thumbnails.favicon);
  assert.equal(hitCount('/favicon.ico'), 0);
  assert.equal(hitCount('/d.png'), 0);
});

test('a page with thousands of icon links costs no more than one with a few', async () => {
  // Unusable links first (SVGs), then duplicates, then a usable one far
  // beyond where the search stops.
  const svgs = Array.from({ length: 6000 }, (unused, i) => `<link rel="icon" href="/i/${i}.svg">`).join('');
  const dupes = '<link rel="icon" href="/same.png">'.repeat(6000);
  routes['/many'] = page('<title>Many</title>', svgs, dupes, '<link rel="icon" href="/last.png">');
  routes['/favicon.ico'] = serve(icoFile([{ size: 32, data: icoBitmap(32, 32, [1, 2, 3, 255]) }]), 'image/x-icon');
  const { body, log } = await preview(`${base}/many`);
  assert.equal(body.preview.title, 'Many');
  assert.ok(body.thumbnails.favicon);
  assert.match(log, /faviconSource=fallback/);
  assert.deepEqual(hits, ['thumbs.test /many', 'thumbs.test /favicon.ico']);

  // Duplicates within reach are tried once.
  thumbnailing.cache.clear();
  hits = [];
  routes['/few'] = page('<title>Few</title>', '<link rel="icon" href="/same.png">'.repeat(20), '<link rel="icon" href="/other.png">');
  await preview(`${base}/few`);
  assert.deepEqual(hits, ['thumbs.test /few', 'thumbs.test /same.png', 'thumbs.test /other.png', 'thumbs.test /favicon.ico']);
});

// ---- One URL, one fetch ----

test('an image that is also the icon is fetched once and rendered as both', async () => {
  routes['/logo.png'] = serve(await solid(400, 400).png().toBuffer());
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/logo.png">', '<link rel="icon" href="/logo.png">');
  const { body, log } = await preview(`${base}/page`);
  assert.deepEqual([body.thumbnails.image.width, body.thumbnails.image.height], [240, 240]);
  assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [32, 32]);
  await decoded(body.thumbnails.image, 'image/webp');
  await decoded(body.thumbnails.favicon, 'image/png');
  assert.equal(hitCount('/logo.png'), 1);
  assert.match(log, /thumbs=complete image=ok imageSource=declared imageMs=\d+ favicon=ok faviconSource=declared/);
});

test('a shared file within the image cap but over the icon cap is used for the image only', async () => {
  const big = await sharp({ create: { width: 700, height: 700, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } } }).png().toBuffer();
  const { image, favicon } = thumbnailing.settings.kinds;
  assert.ok(big.length > favicon.maxBytes && big.length < image.maxBytes, `test image is ${big.length} bytes`);
  routes['/big.png'] = serve(big);
  routes['/favicon.ico'] = serve(icoFile([{ size: 32, data: icoBitmap(32, 32, [1, 2, 3, 255]) }]), 'image/x-icon');
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/big.png">', '<link rel="icon" href="/big.png">');
  const { body, log } = await preview(`${base}/page`);
  assert.ok(body.thumbnails.image);
  assert.ok(body.thumbnails.favicon);
  assert.match(log, /favicon=ok faviconSource=fallback/);
  assert.equal(hitCount('/big.png'), 1);
  // On its own, as an icon only, it is cut off at the icon cap.
  thumbnailing.cache.clear();
  routes['/page'] = page('<title>Page</title>', '<link rel="icon" href="/big.png">');
  routes['/favicon.ico'] = undefined;
  const alone = await preview(`${base}/page`);
  assert.equal(alone.body.thumbnails.favicon, null);
  assert.equal(thumbnailing.cache.entries.get(`favicon ${base}/big.png`).value.outcome, 'too_large');
});

test('requests that overlap share one fetch and one decode per image, whatever page names it', async () => {
  const head = ['<meta property="og:image" content="/site-og.png">', '<link rel="icon" href="/site-icon.png">'];
  const pages = ['/a', '/b', '/c', '/d'];
  for (const path of pages) routes[path] = page(`<title>${path}</title>`, ...head);
  const og = await solid(300, 200).png().toBuffer();
  const icon = await solid(48, 48).png().toBuffer();
  const waiting = [];
  routes['/site-og.png'] = (req, res) => waiting.push(() => serve(og)(req, res));
  routes['/site-icon.png'] = (req, res) => waiting.push(() => serve(icon)(req, res));

  let decodes = 0;
  const restore = withSharp(pipeline => {
    const realToBuffer = pipeline.toBuffer.bind(pipeline);
    pipeline.toBuffer = (...args) => { decodes += 1; return realToBuffer(...args); };
    return pipeline;
  });
  let results;
  try {
    // Four pages of one site, and one of them asked for twice, from different clients.
    const requests = [...pages, '/a'].map((path, i) => preview(`${base}${path}`, '&thumbnails=1', from(`203.0.113.${i + 1}`)));
    while (waiting.length < 2 || thumbnailing.jobs.active < 5) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(thumbnailing.inFlight.size, 2);
    assert.equal(thumbnailing.fetchesInFlight.size, 2);
    waiting.forEach(release => release());
    results = await Promise.all(requests);
  } finally {
    restore();
  }
  assert.equal(hitCount('/site-og.png'), 1);
  assert.equal(hitCount('/site-icon.png'), 1);
  assert.equal(decodes, 2);
  // Each request fetched its own page: nothing of a page's text is shared.
  assert.equal(hitCount('/a'), 2);
  results.forEach(({ body }, i) => {
    assert.equal(body.preview.title, [...pages, '/a'][i]);
    assert.equal(body.thumbnailsStatus, 'complete');
    assert.deepEqual(body.thumbnails, results[0].body.thumbnails);
    assert.ok(body.thumbnails.image && body.thumbnails.favicon);
  });
  await settled();
});

test('a shared fetch that fails gives every waiting request the failure, and leaves nothing behind', async () => {
  const waiting = [];
  routes['/flaky.png'] = (req, res) => waiting.push(() => res.writeHead(503).end());
  for (const path of ['/a', '/b', '/c']) routes[path] = page(`<title>${path}</title>`, '<meta property="og:image" content="/flaky.png">');
  const requests = ['/a', '/b', '/c'].map((path, i) => preview(`${base}${path}`, '&thumbnails=1', from(`203.0.113.${i + 1}`)));
  while (waiting.length < 1 || thumbnailing.jobs.active < 3) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 100));
  waiting.forEach(release => release());
  for (const { status, body } of await Promise.all(requests)) {
    assert.equal(status, 200);
    assert.equal(body.thumbnails.image, null);
    assert.equal(body.thumbnailsStatus, 'transient');
  }
  assert.equal(hitCount('/flaky.png'), 1);
  await settled();
});

test('work a request leaves behind at its deadline still finishes, for the cache', async () => {
  const image = await solid(120, 80).png().toBuffer();
  routes['/slowish.png'] = (req, res) => setTimeout(() => serve(image)(req, res), 900);
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/slowish.png">');
  thumbnailing.tuning.totalTimeoutMs = 600;
  let hurried;
  try {
    hurried = await preview(`${base}/page`);
  } finally {
    thumbnailing.tuning.totalTimeoutMs = 7000;
  }
  assert.equal(hurried.body.thumbnails.image, null);
  assert.equal(hurried.body.thumbnailsStatus, 'transient');
  assert.match(hurried.log, /image=timeout/);
  assert.ok(thumbnailing.jobs.active > 0, 'the place is held while the work goes on');
  await settled();
  const later = await preview(`${base}/page`);
  assert.deepEqual([later.body.thumbnails.image.width, later.body.thumbnails.image.height], [120, 80]);
  assert.match(later.log, /imageCache=hit/);
  assert.equal(hitCount('/slowish.png'), 1);
});

test('an unexpected error fails the request cleanly and leaves nothing behind', async () => {
  routes['/page'] = page('<title>Page</title>');
  const realGet = thumbnailing.engine.get;
  const originalError = console.error;
  console.error = () => {};
  try {
    thumbnailing.engine.get = () => { throw new Error('unexpected'); };
    for (const { status, body } of await Promise.all([preview(`${base}/page`), preview(`${base}/page`)])) {
      assert.equal(status, 500);
      assert.deepEqual(body, { error: 'Internal server error' });
    }
  } finally {
    thumbnailing.engine.get = realGet;
    console.error = originalError;
  }
  await settled();
  assert.equal((await preview(`${base}/page`)).status, 200);
});

// ---- The cache ----

test('thumbnails are cached by image URL, across pages; the page is fetched every time', async () => {
  const head = ['<meta property="og:image" content="/default-og.jpg">', '<link rel="icon" href="/site-icon.png">'];
  routes['/one'] = page('<title>One</title>', ...head);
  routes['/two'] = page('<title>Two</title>', ...head);
  routes['/default-og.jpg'] = serve(await solid(600, 315).jpeg().toBuffer(), 'image/jpeg');
  routes['/site-icon.png'] = serve(await solid(64, 64).png().toBuffer());

  const first = await preview(`${base}/one`);
  assert.equal(hits.length, 3);
  assert.ok(!first.log.includes('Cache=hit'));

  const again = await preview(`${base}/one`);
  assert.deepEqual(again.body.thumbnails, first.body.thumbnails);
  assert.equal(again.body.thumbnailsStatus, 'complete');
  assert.equal(again.cacheControl, 'no-store');
  assert.equal(hitCount('/one'), 2, 'the page text is never served from a cache');
  assert.match(again.log, /thumbs=complete image=ok imageSource=declared imageMs=\d+ imageCache=hit favicon=ok faviconSource=declared faviconMs=\d+ faviconCache=hit$/);

  // A second page of the same site reuses both.
  const two = await preview(`${base}/two`);
  assert.equal(two.body.preview.title, 'Two');
  assert.deepEqual(two.body.thumbnails, first.body.thumbnails);
  assert.equal(hitCount('/default-og.jpg'), 1);
  assert.equal(hitCount('/site-icon.png'), 1);

  // The page's text can change between requests and is seen at once.
  routes['/one'] = page('<title>One, edited</title>', ...head);
  assert.equal((await preview(`${base}/one`)).body.preview.title, 'One, edited');

  // The cache needs a well-formed Authorization header like everything else.
  const noAuth = await preview(`${base}/one`, '&thumbnails=1', {});
  assert.equal(noAuth.status, 401);

  // Plain previews neither read nor fill the cache.
  thumbnailing.cache.clear();
  await preview(`${base}/one`, '');
  assert.equal(thumbnailing.cache.entries.size, 0);

  // A thumbnail is kept for hours; image and icon of one URL are kept apart.
  await preview(`${base}/one`);
  assert.deepEqual([...thumbnailing.cache.entries.keys()].sort(), [`favicon ${base}/site-icon.png`, `image ${base}/default-og.jpg`]);
  const ttl = thumbnailing.cache.entries.get(`image ${base}/default-og.jpg`).expiresAt - Date.now();
  assert.ok(ttl > thumbnailing.settings.cacheTtlMs - 60000 && ttl <= thumbnailing.settings.cacheTtlMs, `ttl ${ttl}`);
});

test('a URL that gave no thumbnail is left alone for a few minutes, and its status is remembered', async () => {
  const ttlOf = key => thumbnailing.cache.entries.get(key).expiresAt - Date.now();
  const { cacheTtlMs, cacheRetryTtlMs } = thumbnailing.settings;
  assert.ok(cacheRetryTtlMs < cacheTtlMs);

  // Neither icon exists: settled.
  routes['/settled'] = page('<title>Settled</title>', '<link rel="icon" href="/gone.png">');
  const settled = await preview(`${base}/settled`);
  assert.equal(settled.body.thumbnailsStatus, 'complete');
  assert.ok(ttlOf(`favicon ${base}/gone.png`) <= cacheRetryTtlMs);
  const settledAgain = await preview(`${base}/settled`);
  assert.equal(settledAgain.body.thumbnailsStatus, 'complete');
  assert.equal(hitCount('/gone.png'), 1);
  assert.equal(hitCount('/favicon.ico'), 1);
  assert.match(settledAgain.log, /favicon=http_404 faviconMs=\d+ faviconCache=hit$/);

  // The image server is having a bad moment: transient, and still reported
  // as transient when the answer comes from the cache.
  for (const status of [500, 503, 429, 408]) {
    thumbnailing.cache.clear();
    hits = [];
    routes['/flaky'] = page('<title>Flaky</title>', '<meta property="og:image" content="/flaky.png">');
    routes['/flaky.png'] = (req, res) => res.writeHead(status).end();
    const flaky = await preview(`${base}/flaky`);
    assert.equal(flaky.body.thumbnailsStatus, 'transient', status);
    assert.match(flaky.log, new RegExp(`thumbs=transient image=http_${status} `));
    assert.ok(ttlOf(`image ${base}/flaky.png`) <= cacheRetryTtlMs);
    const flakyAgain = await preview(`${base}/flaky`);
    assert.equal(flakyAgain.body.thumbnailsStatus, 'transient', status);
    assert.equal(hitCount('/flaky.png'), 1);
  }

  // A connection that drops is transient too.
  thumbnailing.cache.clear();
  routes['/flaky.png'] = (req, res) => res.destroy();
  const dropped = await preview(`${base}/flaky`);
  assert.equal(dropped.body.thumbnailsStatus, 'transient');
  assert.match(dropped.log, /image=error/);

  // Settled refusals are "complete": asking again won't help.
  thumbnailing.cache.clear();
  routes['/flaky.png'] = serve(SVG, 'image/png');
  const refused = await preview(`${base}/flaky`);
  assert.equal(refused.body.thumbnailsStatus, 'complete');
});

test('cache entries expire, and the cache is bounded by count and by bytes', t => {
  const { cache, settings } = thumbnailing;
  const entry = length => ({ thumbnail: { dataUri: 'x'.repeat(length), width: 1, height: 1 }, outcome: 'ok' });
  const miss = { thumbnail: null, outcome: 'http_404' };
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

  cache.set('a', miss, 1000);
  assert.equal(cache.get('a'), miss);
  t.mock.timers.setTime(1_000_999);
  assert.equal(cache.get('a'), miss);
  t.mock.timers.setTime(1_001_000);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.bytes, 0);

  // Least recently used goes first.
  for (let i = 0; i < settings.cacheMaxEntries; i += 1) cache.set(`key${i}`, miss, 60000);
  assert.equal(cache.get('key0'), miss); // now the most recently used
  cache.set('one-more', miss, 60000);
  assert.equal(cache.entries.size, settings.cacheMaxEntries);
  assert.equal(cache.get('key1'), null);
  assert.equal(cache.get('key0'), miss);
  assert.equal(cache.get('one-more'), miss);

  // Replacing an entry doesn't count it twice.
  cache.clear();
  cache.set('same', entry(1000), 60000);
  const withThousand = cache.bytes;
  cache.set('same', entry(400), 60000);
  assert.equal(cache.bytes, withThousand - 600);

  // Total size is capped however few entries there are.
  cache.clear();
  const megabyte = entry(1024 * 1024);
  for (let i = 0; i < 40; i += 1) cache.set(`big${String(i).padStart(4, '0')}`, megabyte, 60000);
  assert.ok(cache.bytes <= settings.cacheMaxBytes);
  assert.ok(cache.entries.size >= 14 && cache.entries.size < 16, `kept ${cache.entries.size}`);
  assert.equal(cache.get('big0000'), null);
  assert.ok(cache.get('big0039'));
  // One entry bigger than the whole cache is simply not kept.
  cache.clear();
  cache.set('enormous', entry(settings.cacheMaxBytes + 1), 60000);
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.bytes, 0);
});

// ---- Bounds on work in flight ----

test('each client gets eight thumbnail jobs at a time, and the bridge sixteen; the rest are told "busy"', async () => {
  const { maxJobs, maxJobsPerClient } = thumbnailing.settings;
  assert.deepEqual([maxJobsPerClient, maxJobs], [8, 16]);
  const image = await solid(300, 300).png().toBuffer();
  const waiting = [];
  // One file as image and icon per page, so each job parks exactly one fetch here.
  for (let i = 0; i < 20; i += 1) {
    routes[`/held${i}.png`] = (req, res) => waiting.push(() => serve(image)(req, res));
    routes[`/page${i}`] = page(`<title>Page ${i}</title>`, `<meta property="og:image" content="/held${i}.png">`, `<link rel="icon" href="/held${i}.png">`);
  }
  const parked = async count => {
    while (waiting.length < count) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(waiting.length, count);
    assert.equal(thumbnailing.jobs.active, count);
  };
  const expectBusy = async (pageUrl, client) => {
    const fetchesBefore = waiting.length;
    const startedAt = Date.now();
    const busy = await preview(pageUrl, '&thumbnails=1', from(client));
    assert.ok(Date.now() - startedAt < 1000, 'a busy request must not queue');
    assert.equal(busy.status, 200);
    assert.ok(busy.body.preview.title.startsWith('Page '));
    assert.equal(busy.body.previewStatus, 'fresh');
    assert.deepEqual(busy.body.thumbnails, { image: null, favicon: null });
    assert.equal(busy.body.thumbnailsStatus, 'busy');
    assert.match(busy.log, /thumbs=busy image=busy imageMs=0 favicon=busy faviconMs=0$/);
    assert.equal(waiting.length, fetchesBefore, 'a busy request fetches no images');
  };

  // The known client's burst: eight lookups at once from one address all get a place...
  const inFlight = [];
  for (let i = 0; i < maxJobsPerClient; i += 1) inFlight.push(preview(`${base}/page${i}`, '&thumbnails=1', from('198.51.100.1')));
  await parked(maxJobsPerClient);
  // ...and a ninth does not.
  await expectBusy(`${base}/page18`, '198.51.100.1');
  assert.equal(thumbnailing.cache.entries.size, 0, 'nothing about a busy answer is cached');

  // That costs nobody else theirs, until the bridge as a whole is full.
  for (let i = maxJobsPerClient; i < maxJobs; i += 1) {
    inFlight.push(preview(`${base}/page${i}`, '&thumbnails=1', from(`198.51.100.${i}`)));
  }
  await parked(maxJobs);
  await expectBusy(`${base}/page19`, '198.51.100.200');

  // Plain previews are not held back by any of this.
  const plain = await preview(`${base}/page0`, '', from('198.51.100.1'));
  assert.equal(plain.body.preview.title, 'Page 0');

  waiting.forEach(release => release());
  for (const { body } of await Promise.all(inFlight)) {
    assert.equal(body.thumbnailsStatus, 'complete');
    assert.deepEqual([body.thumbnails.image.width, body.thumbnails.image.height], [240, 240]);
    assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [32, 32]);
  }
  await settled();

  // With the jobs done, a client that was turned away now succeeds.
  routes['/held18.png'] = serve(image);
  const retry = await preview(`${base}/page18`, '&thumbnails=1', from('198.51.100.1'));
  assert.equal(retry.body.thumbnailsStatus, 'complete');
  assert.ok(retry.body.thumbnails.image);
});

test('a busy request is still given whatever the cache already holds', async () => {
  const image = await solid(200, 100).png().toBuffer();
  routes['/known-og.png'] = serve(image);
  routes['/known-icon.png'] = serve(await solid(32, 32).png().toBuffer());
  routes['/known'] = page('<title>Known</title>', '<meta property="og:image" content="/known-og.png">', '<link rel="icon" href="/known-icon.png">');
  routes['/half'] = page('<title>Half</title>', '<meta property="og:image" content="/new-og.png">', '<link rel="icon" href="/known-icon.png">');
  routes['/new-og.png'] = serve(image);
  const client = '198.51.100.7';
  const primed = await preview(`${base}/known`, '&thumbnails=1', from(client));
  assert.equal(primed.body.thumbnailsStatus, 'complete');

  // Fill every one of the client's places.
  const waiting = [];
  const inFlight = [];
  for (let i = 0; i < thumbnailing.settings.maxJobsPerClient; i += 1) {
    routes[`/held${i}.png`] = (req, res) => waiting.push(() => serve(image)(req, res));
    routes[`/page${i}`] = page('<title>Held</title>', `<meta property="og:image" content="/held${i}.png">`, `<link rel="icon" href="/held${i}.png">`);
    inFlight.push(preview(`${base}/page${i}`, '&thumbnails=1', from(client)));
  }
  while (waiting.length < thumbnailing.settings.maxJobsPerClient) await new Promise(resolve => setTimeout(resolve, 10));
  hits = [];

  // Everything cached: a full answer, no place needed.
  const known = await preview(`${base}/known`, '&thumbnails=1', from(client));
  assert.deepEqual(known.body.thumbnails, primed.body.thumbnails);
  assert.equal(known.body.thumbnailsStatus, 'complete');
  assert.match(known.log, /thumbs=complete image=ok imageSource=declared imageMs=0 imageCache=hit favicon=ok faviconSource=declared faviconMs=0 faviconCache=hit$/);

  // Half cached: the cached half is given, the rest is "busy".
  const half = await preview(`${base}/half`, '&thumbnails=1', from(client));
  assert.equal(half.body.thumbnails.image, null);
  assert.deepEqual(half.body.thumbnails.favicon, primed.body.thumbnails.favicon);
  assert.equal(half.body.thumbnailsStatus, 'busy');
  assert.match(half.log, /thumbs=busy image=busy imageMs=0 favicon=ok faviconSource=declared faviconMs=0 faviconCache=hit$/);
  assert.deepEqual(hits, ['thumbs.test /known', 'thumbs.test /half'], 'only the pages themselves were fetched');

  waiting.forEach(release => release());
  await Promise.all(inFlight);
  await settled();
});

test('no more than two images are decoded at once, however many jobs are running', async () => {
  let decoding = 0;
  let mostAtOnce = 0;
  let decodes = 0;
  const restore = withSharp(pipeline => {
    const realToBuffer = pipeline.toBuffer.bind(pipeline);
    pipeline.toBuffer = async (...args) => {
      decoding += 1;
      decodes += 1;
      mostAtOnce = Math.max(mostAtOnce, decoding);
      try {
        await new Promise(resolve => setTimeout(resolve, 30));
        return await realToBuffer(...args);
      } finally {
        decoding -= 1;
      }
    };
    return pipeline;
  });
  try {
    const requests = [];
    for (let i = 0; i < thumbnailing.settings.maxJobs; i += 1) {
      routes[`/img${i}.png`] = serve(await solid(200 + i, 200).png().toBuffer());
      routes[`/icon${i}.png`] = serve(await solid(40 + i, 40).png().toBuffer());
      routes[`/page${i}`] = page(`<meta property="og:image" content="/img${i}.png">`, `<link rel="icon" href="/icon${i}.png">`);
      requests.push(preview(`${base}/page${i}`, '&thumbnails=1', from(`198.51.100.${i + 1}`)));
    }
    for (const { body } of await Promise.all(requests)) {
      assert.equal(body.thumbnailsStatus, 'complete');
      assert.ok(body.thumbnails.image && body.thumbnails.favicon);
    }
    await settled();
  } finally {
    restore();
  }
  assert.equal(decodes, thumbnailing.settings.maxJobs * 2);
  assert.equal(mostAtOnce, thumbnailing.settings.maxDecodes);
});

test('turns at decoding are shared fairly between clients', async () => {
  const gate = thumbnailing.decodeGate;
  const order = [];
  const finish = {};
  const never = new AbortController().signal;
  const task = (client, name) => gate.run(client, never, () => new Promise(resolve => {
    order.push(name);
    finish[name] = resolve;
  }));
  const tick = () => new Promise(resolve => setImmediate(resolve));

  // A greedy client takes both turns while nobody else wants one, and queues more.
  const all = [task('greedy', 'g1'), task('greedy', 'g2'), task('greedy', 'g3'), task('greedy', 'g4'), task('greedy', 'g5')];
  await tick();
  assert.deepEqual(order, ['g1', 'g2']);
  // Two others arrive later, behind three of the greedy client's.
  all.push(task('second', 's1'), task('second', 's2'), task('third', 't1'));
  await tick();

  // Each turn that frees goes to a client holding fewer, in rotation.
  finish.g1();
  await tick();
  assert.deepEqual(order.slice(2), ['s1'], 'the first freed turn goes to a waiting client, not back to the greedy one');
  assert.equal(gate.held.get('greedy'), 1);
  finish.g2();
  await tick();
  assert.deepEqual(order.slice(2), ['s1', 't1'], 'and the second to the other one');
  assert.equal(gate.held.has('greedy'), false, 'the greedy client holds nothing while others were waiting');
  finish.s1();
  await tick();
  assert.deepEqual(order.slice(2), ['s1', 't1', 'g3'], 'then the greedy client gets a turn of its own');
  finish.t1();
  await tick();
  assert.deepEqual(order.slice(2), ['s1', 't1', 'g3', 's2'], 'but not a second one while someone else waits');
  finish.g3();
  await tick();
  finish.s2();
  await tick();
  assert.deepEqual(order.slice(2), ['s1', 't1', 'g3', 's2', 'g4', 'g5']);
  assert.equal(gate.active, 2);
  finish.g4();
  finish.g5();
  await Promise.all(all);
  assert.deepEqual([gate.active, gate.held.size, gate.queues.size, gate.lastTurn.size], [0, 0, 0, 0]);
});

test('a wait for a decoding turn ends at its deadline, and a failed decode gives its turn back', async () => {
  const gate = thumbnailing.decodeGate;
  const never = new AbortController().signal;
  let release;
  const holders = [
    gate.run('a', never, () => new Promise(resolve => { release = resolve; })),
    gate.run('a', never, () => Promise.reject(new Error('decode failed')))
  ];
  await assert.rejects(holders[1], /decode failed/);
  assert.equal(gate.active, 1);

  let releaseSecond;
  const second = gate.run('a', never, () => new Promise(resolve => { releaseSecond = resolve; }));
  const impatient = new AbortController();
  let ran = false;
  const waiter = gate.run('b', impatient.signal, async () => { ran = true; });
  const alreadyLate = gate.run('c', AbortSignal.abort(), async () => { ran = true; });
  await assert.rejects(alreadyLate, { outcome: 'decode_timeout' });
  assert.equal(gate.queues.size, 1);
  impatient.abort();
  await assert.rejects(waiter, { outcome: 'decode_timeout' });
  assert.equal(ran, false);
  assert.equal(gate.queues.size, 0, 'the abandoned wait is taken out of the queue');
  assert.equal(gate.active, 2);

  release();
  releaseSecond();
  await Promise.all([holders[0], second]);
  assert.deepEqual([gate.active, gate.held.size, gate.queues.size, gate.lastTurn.size], [0, 0, 0, 0]);
});

// ---- Decodes that run out of time ----

test('a decode that hits its time limit is transient, and is not held against the image', async () => {
  routes['/heavy.png'] = serve(await solid(300, 300).png().toBuffer());
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/heavy.png">');
  // What sharp really says when .timeout() fires.
  const restore = withSharp(pipeline => {
    pipeline.toBuffer = async () => { throw new Error('timeout: 52% complete\nVipsImage: killed for image "temp-56"'); };
    return pipeline;
  });
  let slow;
  try {
    slow = await preview(`${base}/page`);
  } finally {
    restore();
  }
  assert.equal(slow.body.thumbnails.image, null);
  assert.equal(slow.body.thumbnailsStatus, 'transient');
  assert.match(slow.log, /thumbs=transient image=decode_timeout/);
  assert.equal(thumbnailing.cache.entries.has(`image ${base}/heavy.png`), false);

  // So the very next request tries again, and succeeds.
  const retry = await preview(`${base}/page`);
  assert.equal(retry.body.thumbnailsStatus, 'complete');
  assert.ok(retry.body.thumbnails.image);
  assert.equal(hitCount('/heavy.png'), 2);
});

test('sharp is told the decode time limit, and a real timeout is reported as sharp words it', async () => {
  // A real libvips timeout needs an image heavier than the pixel limits
  // allow through, so check the two halves: the limit reaches sharp, and
  // sharp's wording for it is the one the bridge looks for.
  const seen = [];
  const restore = withSharp(pipeline => {
    const realTimeout = pipeline.timeout.bind(pipeline);
    pipeline.timeout = options => { seen.push(options); return realTimeout(options); };
    return pipeline;
  });
  try {
    routes['/x.png'] = serve(await solid(50, 50).png().toBuffer());
    routes['/page'] = page('<meta property="og:image" content="/x.png">');
    await preview(`${base}/page`);
  } finally {
    restore();
  }
  assert.deepEqual(seen[0], { seconds: thumbnailing.tuning.decodeTimeoutSeconds });

  const heavy = await sharp({ create: { width: 9000, height: 9000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).jpeg({ quality: 95 }).toBuffer();
  await assert.rejects(
    sharp(heavy, { limitInputPixels: false }).blur(20).timeout({ seconds: 1 }).webp({ effort: 6 }).toBuffer(),
    /\btimeout: \d+% complete/
  );
});

test('a decode still waiting its turn at the deadline is given up, and counts as transient', async () => {
  // Two slow decodes hold both turns past the deadline; a third never starts.
  let started = 0;
  const restore = withSharp(pipeline => {
    const realToBuffer = pipeline.toBuffer.bind(pipeline);
    pipeline.toBuffer = async (...args) => {
      started += 1;
      await new Promise(resolve => setTimeout(resolve, thumbnailing.settings.phaseTimeoutMs + 400));
      return realToBuffer(...args);
    };
    return pipeline;
  });
  let results;
  const startedAt = Date.now();
  try {
    const requests = [];
    for (let i = 0; i < 3; i += 1) {
      routes[`/img${i}.png`] = serve(await solid(100 + i, 100).png().toBuffer());
      routes[`/page${i}`] = page('<title>Page</title>', `<meta property="og:image" content="/img${i}.png">`, `<link rel="icon" href="/img${i}.png">`);
      requests.push(preview(`${base}/page${i}`, '&thumbnails=1', from(`198.51.100.${i + 1}`)));
    }
    results = await Promise.all(requests);
    assert.ok(Date.now() - startedAt < thumbnailing.settings.phaseTimeoutMs + 300, 'answers go out at the deadline, not when the decodes end');
    for (const { body } of results) {
      assert.deepEqual(body.thumbnails, { image: null, favicon: null });
      assert.equal(body.thumbnailsStatus, 'transient');
    }
    // Places are held until the slow decodes really end, then given back.
    assert.ok(thumbnailing.jobs.active > 0);
    await settled();
  } finally {
    restore();
  }
  assert.equal(started, 2, 'decodes that were still queued at the deadline never ran');
  // The two that finished late were worth keeping; nothing was recorded
  // against the images that never got a turn.
  const outcomes = [...thumbnailing.cache.entries.values()].map(entry => entry.value.outcome);
  assert.deepEqual(outcomes, ['ok', 'ok']);
});

// ---- The request's whole allowance ----

test('page fetch and thumbnails share one allowance; thumbnails get what the page left', async () => {
  const { phaseTimeoutMs } = thumbnailing.settings;
  assert.equal(thumbnailing.tuning.totalTimeoutMs, 7000);
  assert.equal(phaseTimeoutMs, 4000);
  const servePage = page('<title>Slow page</title>', '<meta property="og:image" content="/silent.png">', '<link rel="icon" href="/icon.png">');
  // The page takes 3.6 s of the 7 s, leaving the thumbnails 3.4 s, not their usual 4.
  routes['/slow-page'] = (req, res) => setTimeout(() => servePage(req, res), 3600);
  routes['/silent.png'] = () => { /* never answers */ };
  routes['/icon.png'] = serve(await solid(32, 32).png().toBuffer());

  const startedAt = Date.now();
  const { body, log } = await preview(`${base}/slow-page`);
  const elapsed = Date.now() - startedAt;
  assert.equal(body.preview.title, 'Slow page');
  assert.equal(body.thumbnails.image, null);
  assert.ok(body.thumbnails.favicon);
  assert.equal(body.thumbnailsStatus, 'transient');
  assert.match(log, /image=timeout imageMs=3[0-4]\d\d /);
  assert.ok(elapsed >= 6800 && elapsed < 7400, `took ${elapsed}ms; expected about 7000`);
});

test('with almost nothing left, only the cache is consulted', async () => {
  const servePage = page('<title>Late page</title>', '<meta property="og:image" content="/og.png">', '<link rel="icon" href="/icon.png">');
  routes['/quick'] = page('<title>Quick</title>', '<link rel="icon" href="/icon.png">');
  routes['/late-page'] = (req, res) => setTimeout(() => servePage(req, res), 400);
  routes['/og.png'] = serve(await solid(100, 100).png().toBuffer());
  routes['/icon.png'] = serve(await solid(32, 32).png().toBuffer());
  const primed = await preview(`${base}/quick`);
  assert.ok(primed.body.thumbnails.favicon);
  hits = [];

  // 400 ms of a 700 ms allowance gone: under the 500 ms it takes to be worth starting.
  thumbnailing.tuning.totalTimeoutMs = 700;
  let late;
  try {
    late = await preview(`${base}/late-page`);
  } finally {
    thumbnailing.tuning.totalTimeoutMs = 7000;
  }
  assert.equal(late.body.preview.title, 'Late page');
  assert.equal(late.body.thumbnails.image, null);
  assert.deepEqual(late.body.thumbnails.favicon, primed.body.thumbnails.favicon);
  assert.equal(late.body.thumbnailsStatus, 'transient');
  assert.match(late.log, /thumbs=transient image=timeout imageMs=0 favicon=ok faviconSource=declared faviconMs=0 faviconCache=hit$/);
  assert.deepEqual(hits, ['thumbs.test /late-page'], 'no image was fetched');
  assert.equal(thumbnailing.jobs.active, 0);
});

// ---- Without the image library ----

test('if sharp cannot be loaded, thumbnails are "unavailable" and everything else works', async () => {
  routes['/article'] = page('<title>Article</title>', '<meta property="og:image" content="/og.png">', '<link rel="icon" href="/icon.png">');
  routes['/og.png'] = serve(await solid(300, 200).png().toBuffer());
  const { engine } = thumbnailing;
  const real = { sharp: engine.sharp, load: engine.load };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    engine.sharp = undefined;
    let loads = 0;
    engine.load = () => {
      loads += 1;
      throw new Error('Could not load the "sharp" module using the linux-x64 runtime');
    };

    for (let i = 0; i < 2; i += 1) {
      const { status, body, log } = await preview(`${base}/article`);
      assert.equal(status, 200);
      assert.equal(body.preview.title, 'Article');
      assert.equal(body.previewStatus, 'fresh');
      assert.deepEqual(body.thumbnails, { image: null, favicon: null });
      assert.equal(body.thumbnailsStatus, 'unavailable');
      assert.match(log, /thumbs=unavailable image=unavailable imageMs=0 favicon=unavailable faviconMs=0$/);
    }
    assert.equal(hitCount('/og.png'), 0, 'nothing is fetched that could not be decoded');
    assert.equal(loads, 1, 'the load is tried once');
    assert.equal(errors.length, 1, 'and its failure logged once');
    assert.match(errors[0], /Thumbnails are unavailable: the image library failed to load \(Could not load the "sharp" module/);

    const plain = await preview(`${base}/article`, '');
    assert.deepEqual(Object.keys(plain.body), ['preview', 'previewStatus']);
    const health = await fetch(`http://127.0.0.1:${bridge.address().port}/health`);
    assert.equal(health.status, 200);
  } finally {
    engine.sharp = real.sharp;
    engine.load = real.load;
    console.error = originalError;
  }
  const back = await preview(`${base}/article`);
  assert.equal(back.body.thumbnailsStatus, 'complete');
});
