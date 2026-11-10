'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { networkFor, findRepoRoot } = require('../src/local-stack.cjs');

const ifaces = (address, cidr) => ({ Ethernet: [{ family: 'IPv4', address, cidr, internal: false }], lo: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }] });

test('home network is the subnet of the interface with the default route', () => {
  assert.deepEqual(networkFor('192.168.1.147', ifaces('192.168.1.147', '192.168.1.147/24')), { iface: 'Ethernet', address: '192.168.1.147', cidr: '192.168.1.0/24', private: true });
  assert.equal(networkFor('10.0.5.9', ifaces('10.0.5.9', '10.0.5.9/22')).cidr, '10.0.4.0/22');
});

test('very large subnets are narrowed to the /24 around this computer', () => {
  assert.equal(networkFor('10.20.30.40', ifaces('10.20.30.40', '10.20.30.40/8')).cidr, '10.20.30.0/24');
});

test('public addresses are flagged so they are never offered for scanning', () => {
  assert.equal(networkFor('203.0.113.7', ifaces('203.0.113.7', '203.0.113.7/24')).private, false);
  assert.equal(networkFor('172.32.0.1', ifaces('172.32.0.1', '172.32.0.1/24')).private, false);
  assert.equal(networkFor('172.20.0.1', ifaces('172.20.0.1', '172.20.0.1/24')).private, true);
});

test('unknown address → null', () => {
  assert.equal(networkFor('192.168.9.9', ifaces('192.168.1.2', '192.168.1.2/24')), null);
});

test('finds the source checkout from inside the desktop app', () => {
  const root = findRepoRoot(path.join(__dirname, '..', 'src'));
  assert.ok(root && require('node:fs').existsSync(path.join(root, 'scripts', 'local.mjs')), `got ${root}`);
});
