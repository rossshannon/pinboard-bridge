// One user and token share a Pinboard queue however the header spells them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const startedAt = [];
axios.defaults.adapter = async config => {
  startedAt.push(Date.now());
  return { data: { ok: true }, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, config, request: {} };
};

process.env.PORT = '0';
process.env.PINBOARD_MIN_INTERVAL_MS = '400';
process.env.PINBOARD_MAX_QUEUE_MS = '2000';
const { server } = require('../web.js');

before(async () => {
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
});
after(() => server.close());

const call = authorization => fetch(`http://127.0.0.1:${server.address().port}/v1/tags/get?format=json`, { headers: { Authorization: authorization } });

test('Basic and Bearer forms of the same credential are spaced as one user', async () => {
  const basic = 'Basic ' + Buffer.from('alice:TOKEN1').toString('base64');
  const responses = await Promise.all([call(basic), call('Bearer alice:TOKEN1'), call('bearer   alice:TOKEN1')]);
  assert.deepEqual(responses.map(res => res.status), [200, 200, 200]);
  assert.equal(startedAt.length, 3);
  startedAt.sort((a, b) => a - b);
  assert.ok(startedAt[1] - startedAt[0] >= 350, `second call started ${startedAt[1] - startedAt[0]} ms after the first`);
  assert.ok(startedAt[2] - startedAt[1] >= 350, `third call started ${startedAt[2] - startedAt[1]} ms after the second`);
});

test('a different token for the same username has its own queue', async () => {
  startedAt.length = 0;
  const began = Date.now();
  const res = await call('Bearer alice:OTHERTOKEN');
  assert.equal(res.status, 200);
  assert.ok(startedAt[0] - began < 300, 'the other credential was not held behind alice:TOKEN1');
});
