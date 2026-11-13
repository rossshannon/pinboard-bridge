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

beforeEach(() => {
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

// Pages close their own connection, so that the connection checks below see
// only what the bridge does with its image fetches.
const page = (...headTags) => (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
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
  assert.deepEqual(Object.keys(body), ['preview', 'previewStatus', 'thumbnails']);
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

  assert.match(log, /\[preview\] route=preview user=alice host=thumbs\.test outcome=preview_generated previewMs=\d+ cache=miss image=ok imageMs=\d+ favicon=ok faviconSource=declared faviconMs=\d+$/);
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

test('tall images fit inside 240x240, and WebP, GIF and AVIF sources are accepted', async () => {
  const sources = {
    '/tall.webp': await solid(300, 900).webp().toBuffer(),
    '/tall.gif': await solid(300, 900).gif().toBuffer(),
    '/tall.avif': await solid(300, 900).avif().toBuffer(),
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

test('a page that cannot be fetched gets null thumbnails and no icon request', async () => {
  const missing = await preview(`${base}/missing`);
  assert.deepEqual(missing.body, {
    preview: null,
    previewStatus: 'error',
    previewError: 'Page returned HTTP 404',
    thumbnails: { image: null, favicon: null }
  });
  assert.deepEqual(hits, ['thumbs.test /missing']);
  assert.match(missing.log, /outcome=preview_failed .*cache=miss image=no_page imageMs=0 favicon=no_page faviconMs=0$/);

  const blocked = await preview(`http://private.test:${port}/`);
  assert.equal(blocked.body.previewError, 'URL host is not reachable from the proxy');
  assert.deepEqual(blocked.body.thumbnails, { image: null, favicon: null });

  routes['/file.pdf'] = serve(Buffer.from('%PDF-1.7'), 'application/pdf');
  const notHtml = await preview(`${base}/file.pdf`);
  assert.equal(notHtml.body.previewError, 'Preview response is not HTML');
  assert.deepEqual(notHtml.body.thumbnails, { image: null, favicon: null });
  assert.equal(hitCount('/favicon.ico'), 0);
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
    assert.match(log, /image=blocked/, path);
    assert.equal(hitCount(path), 2, path);
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
  assert.equal(thumbnailing.jobs.active, 0);

  // A timeout is only remembered for a short while.
  const entry = thumbnailing.cache.entries.get(`${base}/page`);
  const ttl = entry.expiresAt - Date.now();
  assert.ok(ttl > 0 && ttl <= thumbnailing.settings.cacheRetryTtlMs, `ttl ${ttl}`);
});

test('an image server that never answers is dropped at the deadline', async () => {
  routes['/silent.png'] = () => { /* accept the request and say nothing */ };
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/silent.png">');
  const startedAt = Date.now();
  const { body, log } = await preview(`${base}/page`);
  assert.equal(body.thumbnails.image, null);
  assert.match(log, /image=timeout/);
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
    assert.match(log, /image=(unsupported|undecodable) /, name);
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
  // HEIC and other ISO media are not AVIF.
  assert.equal(sniffImageFormat(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic')), null);
  assert.equal(sniffImageFormat(Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0isommp42')), null);
  assert.equal(sniffImageFormat(Buffer.from('\0\0\0\x1cftypmif1\0\0\0\0mif1avifmiaf')), 'avif');
  assert.equal(sniffImageFormat(Buffer.from('\0\0\0\x10ftypavif')), 'avif');
  // A truncated box header must not read out of range.
  assert.equal(sniffImageFormat(Buffer.from('\xff\xff\xff\xffftyp', 'latin1')), null);
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
});

test('images with decompression-bomb dimensions are refused', async () => {
  // Tiny files, enormous canvases: past the pixel limits for each kind.
  const hugeImage = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#123' } }).png().toBuffer();
  const hugeIcon = await sharp({ create: { width: 2100, height: 2100, channels: 3, background: '#123' } }).png().toBuffer();
  assert.ok(hugeImage.length < thumbnailing.settings.kinds.image.maxBytes);
  assert.ok(5000 * 5000 > thumbnailing.settings.kinds.image.maxPixels);
  assert.ok(2100 * 2100 > thumbnailing.settings.kinds.favicon.maxPixels);
  routes['/huge.png'] = serve(hugeImage);
  routes['/huge-icon.png'] = serve(hugeIcon);
  // The same icon wrapped in an .ico must not get round the limit.
  routes['/favicon.ico'] = serve(icoFile([{ size: 256, data: hugeIcon }]), 'image/x-icon');
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/huge.png">', '<link rel="icon" href="/huge-icon.png">');

  const startedAt = Date.now();
  const { body, log } = await preview(`${base}/page`);
  assert.deepEqual(body.thumbnails, { image: null, favicon: null });
  assert.match(log, /image=undecodable imageMs=\d+ favicon=undecodable/);
  assert.ok(Date.now() - startedAt < 2000, 'refused from the header, without decoding');

  // The icon-sized limit applies to icons only: this one is fine as an image.
  routes['/page'] = page('<title>Page</title>', '<meta property="og:image" content="/huge-icon.png">');
  thumbnailing.cache.clear();
  const ok = await preview(`${base}/page`);
  assert.deepEqual([ok.body.thumbnails.image.width, ok.body.thumbnails.image.height], [240, 240]);
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

test('picks the ICO entry best suited to 32px, bitmap or embedded PNG', async () => {
  const { pickIcoImage } = thumbnailing;
  const png48 = await solid(48, 48).png().toBuffer();

  const mixed = pickIcoImage(icoFile([
    { size: 256, data: icoBitmap(64, 32, [9, 9, 9, 255]) },
    { size: 16, data: icoBitmap(16, 32, [1, 1, 1, 255]) },
    { size: 48, data: png48 }
  ]), 32);
  assert.ok(mixed.png.equals(png48), 'the smallest entry of at least 32px wins');

  const onlySmall = pickIcoImage(icoFile([
    { size: 16, data: icoBitmap(16, 32, [1, 1, 1, 255]) },
    { size: 24, data: icoBitmap(24, 32, [2, 2, 2, 255]) }
  ]), 32);
  assert.deepEqual([onlySmall.raw.width, onlySmall.raw.height], [24, 24]);

  // Pixels come out as RGBA, top row first.
  const bitmap = icoBitmap(2, 32, [10, 20, 30, 40]);
  bitmap.writeUInt8(99, 40 + 8); // blue of the stored second row = image's top-left
  const { raw } = pickIcoImage(icoFile([{ size: 2, data: bitmap }]), 32);
  assert.deepEqual([...raw.rgba.subarray(0, 4)], [10, 20, 99, 40]);
  assert.deepEqual([...raw.rgba.subarray(8, 12)], [10, 20, 30, 40]);

  // 24-bit entries are opaque except where the mask says otherwise.
  const masked = icoBitmap(2, 24, [10, 20, 30]);
  masked[40 + 16] = 0x80; // mask bit for the stored first row's first pixel = bottom-left
  const opaque = pickIcoImage(icoFile([{ size: 2, bitCount: 24, data: masked }]), 32).raw;
  assert.deepEqual([...opaque.rgba], [10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 0, 10, 20, 30, 255]);

  // A 32-bit entry with an all-zero alpha channel is not left invisible.
  const noAlpha = pickIcoImage(icoFile([{ size: 2, data: icoBitmap(2, 32, [5, 6, 7, 0]) }]), 32).raw;
  assert.deepEqual([...noAlpha.rgba.subarray(0, 4)], [5, 6, 7, 255]);

  // An undecodable best entry falls through to the next.
  const palette = icoBitmap(32, 32, [0, 0, 0, 255]);
  palette.writeUInt16LE(8, 14);
  const fallthrough = pickIcoImage(icoFile([{ size: 32, data: palette }, { size: 64, data: png48 }]), 32);
  assert.ok(fallthrough.png.equals(png48));
});

test('malformed ICO files are refused without reading out of range', async () => {
  const { pickIcoImage } = thumbnailing;
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
    'palette bitmap': withHeader(good, b => b.writeUInt16LE(8, 14)),
    'zero bit depth': withHeader(good, b => b.writeUInt16LE(0, 14)),
    'pixel rows cut short': icoFile([{ size: 32, data: good.subarray(0, 40 + 32 * 4 * 10) }])
  };
  for (const [name, file] of Object.entries(malformed)) {
    assert.equal(pickIcoImage(file, 32), null, name);
  }

  // A bitmap whose mask is missing is still decoded, as opaque.
  const noMask = pickIcoImage(icoFile([{ size: 32, bitCount: 24, data: icoBitmap(32, 24, [1, 2, 3]).subarray(0, 40 + 96 * 32) }]), 32);
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
  const { pickIcoImage } = thumbnailing;
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  for (let i = 0; i < 2000; i += 1) {
    const file = Buffer.alloc(6 + (random() % 400));
    for (let at = 0; at < file.length; at += 1) file[at] = random() & (random() % 3 ? 0x03 : 0xff);
    file.writeUInt16LE(0, 0);
    file.writeUInt16LE(1, 2);
    file.writeUInt16LE(1 + (random() % 3), 4);
    const picked = pickIcoImage(file, 32);
    if (picked?.raw) assert.equal(picked.raw.rgba.length, picked.raw.width * picked.raw.height * 4);
  }
});

// ---- The cache ----

test('a repeated thumbnail request is answered from the cache', async () => {
  routes['/article'] = page('<title>Article</title>', '<meta property="og:image" content="/og.jpg">', '<link rel="icon" href="/icon.png">');
  routes['/og.jpg'] = serve(await solid(600, 315).jpeg().toBuffer(), 'image/jpeg');
  routes['/icon.png'] = serve(await solid(64, 64).png().toBuffer());

  const first = await preview(`${base}/article`);
  assert.equal(hits.length, 3);
  const second = await preview(`${base}/article`);
  assert.equal(second.status, 200);
  assert.equal(second.text, first.text);
  assert.equal(second.cacheControl, 'no-store');
  assert.equal(hits.length, 3, 'nothing was fetched again');
  assert.match(second.log, /\[preview\] route=preview user=alice host=thumbs\.test cache=hit$/);

  // A fragment is not part of the page's address.
  await preview(`${base}/article#section`);
  assert.equal(hits.length, 3);
  // A different query string is a different page.
  routes['/article?page=2'] = routes['/article'];
  await preview(`${base}/article?page=2`);
  assert.equal(hitCount('/article?page=2'), 1);

  // The cache needs a well-formed Authorization header like everything else.
  const noAuth = await preview(`${base}/article`, '&thumbnails=1', {});
  assert.equal(noAuth.status, 401);

  // Plain previews neither read nor fill the cache.
  const before = thumbnailing.cache.entries.size;
  await preview(`${base}/article`, '');
  assert.equal(hitCount('/article'), 2);
  assert.equal(thumbnailing.cache.entries.size, before);

  const entry = thumbnailing.cache.entries.get(`${base}/article`);
  const ttl = entry.expiresAt - Date.now();
  assert.ok(ttl > thumbnailing.settings.cacheTtlMs - 60000 && ttl <= thumbnailing.settings.cacheTtlMs, `ttl ${ttl}`);
});

test('settled misses are cached for long, failures that may pass only briefly', async () => {
  const ttlOf = url => thumbnailing.cache.entries.get(url).expiresAt - Date.now();
  const { cacheTtlMs, cacheRetryTtlMs } = thumbnailing.settings;

  // No image, and neither icon exists: that won't change soon.
  routes['/settled'] = page('<title>Settled</title>', '<link rel="icon" href="/gone.png">');
  await preview(`${base}/settled`);
  assert.ok(ttlOf(`${base}/settled`) > cacheRetryTtlMs);

  // The image server is having a bad moment.
  routes['/flaky'] = page('<title>Flaky</title>', '<meta property="og:image" content="/500.png">');
  routes['/500.png'] = (req, res) => res.writeHead(503).end();
  await preview(`${base}/flaky`);
  assert.ok(ttlOf(`${base}/flaky`) <= cacheRetryTtlMs);

  // The page itself failed.
  await preview(`${base}/missing`);
  assert.ok(ttlOf(`${base}/missing`) <= cacheRetryTtlMs);
  await preview(`${base}/missing`);
  assert.equal(hitCount('/missing'), 1);
  assert.ok(cacheRetryTtlMs < cacheTtlMs);
});

test('cache entries expire, and the cache is bounded by count and by bytes', t => {
  const { cache, settings } = thumbnailing;
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });

  cache.set('a', '{"a":1}', 1000);
  assert.equal(cache.get('a'), '{"a":1}');
  t.mock.timers.setTime(1_000_999);
  assert.equal(cache.get('a'), '{"a":1}');
  t.mock.timers.setTime(1_001_000);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.bytes, 0);

  // Least recently used goes first.
  for (let i = 0; i < settings.cacheMaxEntries; i += 1) cache.set(`key${i}`, 'x', 60000);
  assert.equal(cache.get('key0'), 'x'); // now the most recently used
  cache.set('one-more', 'x', 60000);
  assert.equal(cache.entries.size, settings.cacheMaxEntries);
  assert.equal(cache.get('key1'), null);
  assert.equal(cache.get('key0'), 'x');
  assert.equal(cache.get('one-more'), 'x');

  // Replacing an entry doesn't count it twice.
  cache.clear();
  cache.set('same', 'x'.repeat(100), 60000);
  cache.set('same', 'y'.repeat(50), 60000);
  assert.equal(cache.bytes, 50 + 4);

  // Total size is capped however few entries there are.
  cache.clear();
  const megabyte = 'x'.repeat(1024 * 1024);
  const fits = Math.floor(settings.cacheMaxBytes / (megabyte.length + 8));
  for (let i = 0; i < fits + 5; i += 1) cache.set(`big${String(i).padStart(4, '0')}`, megabyte, 60000);
  assert.ok(cache.bytes <= settings.cacheMaxBytes);
  assert.equal(cache.entries.size, fits);
  assert.equal(cache.get('big0000'), null);
  // One body bigger than the whole cache is simply not kept.
  cache.clear();
  cache.set('enormous', 'x'.repeat(settings.cacheMaxBytes + 1), 60000);
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.bytes, 0);
});

// ---- The concurrency bound ----

test('at most four requests build thumbnails at once; the next gets nulls and is not cached', async () => {
  const { maxJobs } = thumbnailing.settings;
  const image = await solid(300, 300).png().toBuffer();
  const waiting = [];
  routes['/held.png'] = (req, res) => waiting.push(() => serve(image)(req, res));
  for (let i = 0; i <= maxJobs; i += 1) {
    routes[`/page${i}`] = page(`<title>Page ${i}</title>`, '<meta property="og:image" content="/held.png">', '<link rel="icon" href="/held.png">');
  }

  const inFlight = [];
  for (let i = 0; i < maxJobs; i += 1) inFlight.push(preview(`${base}/page${i}`));
  // Two fetches (image and icon) per request are now parked on the server.
  while (waiting.length < maxJobs * 2) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(thumbnailing.jobs.active, maxJobs);

  const startedAt = Date.now();
  const extra = await preview(`${base}/page${maxJobs}`);
  assert.ok(Date.now() - startedAt < 1000, 'the extra request must not queue');
  assert.equal(extra.status, 200);
  assert.equal(extra.body.preview.title, `Page ${maxJobs}`);
  assert.equal(extra.body.previewStatus, 'fresh');
  assert.deepEqual(extra.body.thumbnails, { image: null, favicon: null });
  assert.match(extra.log, /image=busy imageMs=0 favicon=busy faviconMs=0$/);
  assert.equal(waiting.length, maxJobs * 2, 'the extra request fetched no images');
  assert.equal(thumbnailing.cache.entries.has(`${base}/page${maxJobs}`), false);

  // Plain previews are not held back by busy thumbnail jobs.
  const plain = await preview(`${base}/page0`, '');
  assert.equal(plain.body.preview.title, 'Page 0');

  waiting.forEach(release => release());
  const results = await Promise.all(inFlight);
  for (const { body } of results) {
    assert.deepEqual([body.thumbnails.image.width, body.thumbnails.image.height], [240, 240]);
    assert.deepEqual([body.thumbnails.favicon.width, body.thumbnails.favicon.height], [32, 32]);
  }
  for (let i = 0; i < 50 && thumbnailing.jobs.active > 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(thumbnailing.jobs.active, 0);

  // With the jobs done, the request that was turned away now succeeds.
  routes['/held.png'] = serve(image);
  const retry = await preview(`${base}/page${maxJobs}`);
  assert.ok(retry.body.thumbnails.image);
});
