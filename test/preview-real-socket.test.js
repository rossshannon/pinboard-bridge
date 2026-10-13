// Runs fetchPreview against a real local HTTP server with axios's real
// adapter, so the SSRF lookup, redirect guard, deadline and socket teardown
// are exercised as they run in production.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const { Readable } = require('node:stream');

process.env.PORT = '0';
const { server: bridge, fetchPreview, readHead, addressGuard, isPrivateAddress } = require('../web.js');

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
      while (!res.destroyed && res.write(filler)) { /* keep the pipe full */ }
      if (!res.destroyed) res.once('drain', pump);
    };
    pump();
  };
  const preview = await fetchPreview(new URL(`${base}/no-head-end`));
  assert.equal(preview.title, 'Capped');
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
});

test('reads no more than 512 KB of a head that never ends', async () => {
  // Socket buffers make bytes sent a poor measure, so count what readHead pulls.
  let pulled = 0;
  const chunk = Buffer.from(`<meta name="x" content="${'x'.repeat(1000)}">`);
  const stream = new Readable({
    read() {
      pulled += chunk.length;
      this.push(chunk);
    }
  });
  const body = await readHead(stream);
  assert.ok(body.length >= 512 * 1024, `read only ${body.length} bytes`);
  assert.ok(pulled < 512 * 1024 + 64 * 1024, `pulled ${pulled} bytes; expected to stop at 512 KB`);
});

test('treats the start of <body> as the end of a head with no </head>', async () => {
  routes['/no-close-tag'] = (req, res) => {
    html(res);
    res.write('<html><head><title>Implied</title><meta property="og:description" content="No close tag"><body><p>');
    // Never ended: the bridge must stop at <body>, not wait for the cap or the deadline.
  };
  const startedAt = Date.now();
  const preview = await fetchPreview(new URL(`${base}/no-close-tag`));
  assert.equal(preview.description, 'No close tag');
  assert.ok(Date.now() - startedAt < 1000);
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
});

test('tells the client only that a page could not be fetched, not why', async () => {
  // A port nothing listens on: the raw error would name the address and port.
  const closed = http.createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise(resolve => closed.close(resolve));

  const lines = [];
  const originalInfo = console.info;
  console.info = (...args) => { lines.push(args.join(' ')); };
  let body;
  try {
    const res = await fetch(`http://127.0.0.1:${bridge.address().port}/preview?url=${encodeURIComponent(`http://preview.test:${port}/`)}`, {
      headers: { Authorization: 'Basic ' + Buffer.from('alice:secret').toString('base64') }
    });
    body = await res.json();
  } finally {
    console.info = originalInfo;
  }
  assert.equal(body.previewError, 'Could not fetch the page');
  assert.ok(!JSON.stringify(body).includes('ECONNREFUSED'));
  // The detail still reaches our own logs.
  assert.ok(lines.some(line => line.includes('ECONNREFUSED')), lines.join(' | '));
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

test('ignores </head> and <body> inside scripts, styles, templates and comments', async () => {
  routes['/tricky-head'] = (req, res) => {
    html(res);
    // Each raw-text block holds a fake boundary, split across writes.
    const parts = [
      '<html><head><title>Tricky</title><script>var t = "</he',
      'ad><body>";</script><style>/* </head> */</style>',
      '<template><body></template><!-- <body> </head> -->',
      '<meta property="og:description" content="Past the decoys"></HEAD ><body>'
    ];
    parts.forEach((part, i) => setTimeout(() => res.write(part), i * 20));
  };
  const preview = await fetchPreview(new URL(`${base}/tricky-head`));
  assert.equal(preview.description, 'Past the decoys');
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
});

test('ignores head-like text in titles and nested templates, and empty comments', async () => {
  routes['/trickier-head'] = (req, res) => {
    html(res);
    const parts = [
      '<html><head><title>About <script> tags and <body></title>',
      '<template><template></template><body></head></template>',
      '<!--><!--->',
      '<meta property="og:description" content="Past the second decoys"></head><body>'
    ];
    parts.forEach((part, i) => setTimeout(() => res.write(part), i * 20));
  };
  const startedAt = Date.now();
  const preview = await fetchPreview(new URL(`${base}/trickier-head`));
  assert.equal(preview.description, 'Past the second decoys');
  assert.ok(Date.now() - startedAt < 1000, 'expected the read to stop at the real </head>');
  assert.ok(await allClosed(), 'expected the bridge to close the connection');
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
