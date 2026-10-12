// Runs fetchPreview against a real local HTTP server with axios's real
// adapter, so the SSRF lookup, redirect guard, deadline and socket teardown
// are exercised as they run in production.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');

process.env.PORT = '0';
const { server: bridge, fetchPreview, addressGuard, isPrivateAddress } = require('../web.js');

// Let the loopback test server through; everything else keeps the real rules.
addressGuard.isPrivate = address => address !== '127.0.0.1' && isPrivateAddress(address);

const HOSTS = { 'preview.test': '127.0.0.1', 'private.test': '10.0.0.1' };
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

const routes = {};
const target = http.createServer((req, res) => {
  const handler = routes[req.url];
  if (handler) return handler(req, res);
  res.writeHead(404).end();
});
let base;

before(async () => {
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  base = `http://preview.test:${target.address().port}`;
});

after(() => {
  dns.lookup = realLookup;
  target.closeAllConnections();
  target.close();
  bridge.close();
});

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

const html = (res, extraHeaders = {}) => res.writeHead(200, { 'content-type': 'text/html', ...extraHeaders });

test('reads the head, then hangs up on a body that never ends', async () => {
  routes['/endless'] = (req, res) => {
    html(res);
    res.write('<html><head><title>Real</title><meta property="og:description" content="Head only"></head><body>');
    // Never ended: only the bridge hanging up closes this.
  };
  const preview = await fetchPreview(new URL(`${base}/endless`));
  assert.equal(preview.title, 'Real');
  assert.equal(preview.description, 'Head only');
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
});

test('closes the connection on a non-HTML response it never reads', async () => {
  routes['/file.pdf'] = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.write('%PDF-1.7');
  };
  await assert.rejects(fetchPreview(new URL(`${base}/file.pdf`)), /not HTML/);
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
});

test('closes the connection on an error page with a slow body', async () => {
  for (const status of [404, 500]) {
    routes[`/error-${status}`] = (req, res) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.write('<html><head><title>Error</title>');
      // Never ended: only the bridge hanging up closes this.
    };
    await assert.rejects(fetchPreview(new URL(`${base}/error-${status}`)), new RegExp(String(status)));
    assert.ok(await allClosed(), `expected the bridge to close the connection after a ${status}`);
  }
});

test('stops at the byte cap when a page never closes its head', async () => {
  routes['/no-head-end'] = (req, res) => {
    html(res);
    res.write('<html><head><title>Capped</title>');
    const filler = `<meta name="x" content="${'x'.repeat(1000)}">`;
    const pump = () => {
      while (res.write(filler)) { /* keep the pipe full */ }
      res.once('drain', pump);
    };
    pump();
  };
  const preview = await fetchPreview(new URL(`${base}/no-head-end`));
  assert.equal(preview.title, 'Capped');
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
});

test('does not mistake </header> for the end of the head', async () => {
  routes['/header-in-head'] = (req, res) => {
    html(res);
    // Two writes, so the bridge sees </header> before the rest of the head.
    res.write('<html><head><script>var t = "</header>";</script>');
    setTimeout(() => res.end('<meta property="og:description" content="After the script"></head></html>'), 50);
  };
  const preview = await fetchPreview(new URL(`${base}/header-in-head`));
  assert.equal(preview.description, 'After the script');
});

test('refuses a hostname that resolves to a private address', async () => {
  await assert.rejects(
    fetchPreview(new URL(`http://private.test:${target.address().port}/`)),
    /not reachable from the proxy/
  );
});

test('refuses a redirect to a private address', async () => {
  routes['/bounce'] = (req, res) => {
    res.writeHead(302, { location: 'http://10.0.0.1/admin' }).end();
  };
  await assert.rejects(fetchPreview(new URL(`${base}/bounce`)), /not reachable from the proxy/);
});

test('gives up on a page that stalls before its head closes', async () => {
  routes['/stall'] = (req, res) => {
    html(res);
    res.write('<html><head><title>Slow');
  };
  const startedAt = Date.now();
  await assert.rejects(fetchPreview(new URL(`${base}/stall`)), /timed out after 5000ms/);
  assert.ok(Date.now() - startedAt < 7000);
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
});
