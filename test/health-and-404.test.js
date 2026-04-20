const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// The health & 404 handlers don't touch axios, so the adapter just fails loud
// if anything unexpectedly reaches it.
axios.defaults.adapter = async (config) => {
  throw new Error(`Unexpected upstream call to ${config.url}`);
};

process.env.PORT = '0';
const { server } = require('../web.js');

before(async () => {
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
});

after(() => {
  server.close();
});

const baseUrl = () => `http://127.0.0.1:${server.address().port}`;

test('/health returns 200 with status, uptime and timestamp', async () => {
  const res = await fetch(`${baseUrl()}/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.status, 'healthy');
  assert.equal(typeof body.uptime, 'number');
  assert.ok(body.uptime >= 0);
  assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('unknown path returns JSON 404', async () => {
  const res = await fetch(`${baseUrl()}/does-not-exist`);
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.equal(body.error, 'Not found');
});

test('POST on a GET-only route falls through to the 404 handler', async () => {
  const res = await fetch(`${baseUrl()}/health`, { method: 'POST' });
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.equal(body.error, 'Not found');
});
