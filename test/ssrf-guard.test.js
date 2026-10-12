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

test('IPv6 forms that embed or stand in for a private IPv4 address are refused', () => {
  for (const address of [
    '::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1',
    '64:ff9b:1::1', '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001:0:4136:e378::1',
    'fec0::1', 'ff02::1', '0:0:0:0:0:0:0:1'
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['64:ff9b::808:808', '2002:808:808::1', '2001:4860::8888']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('reserved, benchmarking and multicast IPv4 ranges are refused', () => {
  for (const address of ['192.0.0.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('192.0.2.1'), false);
  assert.equal(isPrivateAddress('198.20.0.1'), false);
});

test('a trailing dot does not hide localhost', () => {
  assert.equal(isPrivateHostname('localhost.'), true);
  assert.equal(isPrivateHostname('foo.localhost.'), true);
  assert.equal(isPrivateHostname('.'), true);
});
