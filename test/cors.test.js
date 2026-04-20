const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// Stub axios so an accidental upstream call during CORS exploration fails loudly
// instead of hitting the real Pinboard API.
axios.defaults.adapter = async (config) => {
  throw new Error(`Unexpected upstream call to ${config.url}`);
};

// Must be set BEFORE requiring ../web.js — ALLOWED_ORIGINS is captured once at
// module load into a const. Node's test runner launches each test file in its
// own subprocess, so this env isn't visible to the other test files.
process.env.PORT = '0';
process.env.ALLOWED_ORIGINS = 'https://allowed.example.com,https://also-allowed.example.com';

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

test('OPTIONS preflight from an allowed origin returns 2xx with CORS headers', async () => {
  const res = await fetch(`${baseUrl()}/health`, {
    method: 'OPTIONS',
    headers: {
      'Origin': 'https://allowed.example.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Authorization'
    }
  });

  // cors() ends preflight with 204 by default; any 2xx is fine.
  assert.ok(res.status >= 200 && res.status < 300, `expected 2xx, got ${res.status}`);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://allowed.example.com');
});

test('GET from an allowed origin succeeds and echoes the origin in ACAO', async () => {
  const res = await fetch(`${baseUrl()}/health`, {
    headers: { 'Origin': 'https://also-allowed.example.com' }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://also-allowed.example.com');
});

test('GET from a disallowed origin is rejected with a JSON 403', async () => {
  const res = await fetch(`${baseUrl()}/health`, {
    headers: { 'Origin': 'https://evil.example.com' }
  });
  const body = await res.json();

  assert.equal(res.status, 403);
  assert.match(body.error, /CORS/i);
});

test('request without an Origin header passes through (curl / server-to-server)', async () => {
  // fetch() doesn't auto-send an Origin header for same-origin requests, but
  // we want to be explicit about what the code is guaranteeing.
  const res = await fetch(`${baseUrl()}/health`);
  assert.equal(res.status, 200);
});
