const { test, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = '0';
const { server, isPrivateAddress, isPrivateHostname, guardRedirect } = require('../web.js');

after(() => {
  server.close();
});

test('private and special-purpose addresses are refused', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.1.1', '::', '::1', 'fd00::1', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe'
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});

test('public addresses are allowed', () => {
  for (const address of ['8.8.8.8', '100.128.0.1', '172.32.0.1', '2606:4700::1111', '::ffff:808:808']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('bracketed IPv6 hosts from URL parsing are checked', () => {
  assert.equal(isPrivateHostname(new URL('http://[::ffff:127.0.0.1]/').hostname), true);
  assert.equal(isPrivateHostname(new URL('http://0.0.0.0:1337/').hostname), true);
  assert.equal(isPrivateHostname('example.com'), false);
});

test('a redirect to a private host is stopped', () => {
  assert.throws(() => guardRedirect({ hostname: '169.254.169.254' }), /not reachable/);
  assert.doesNotThrow(() => guardRedirect({ hostname: 'example.com' }));
});
