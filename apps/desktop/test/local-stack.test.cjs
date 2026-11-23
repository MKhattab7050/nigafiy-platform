'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const dgram = require('node:dgram');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { homeNetwork, networkFor, findRepoRoot, signIn } = require('../src/local-stack.cjs');

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

test('signIn preserves base64-padded cookies and does not overwrite saved account on transient 500/429 errors', async () => {
  let loginStatus = 503;
  let saved = { email: 'owner@nigafiy.local', password: 'secret-password' };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v1/auth/login') {
      res.writeHead(loginStatus, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'ld_session=abc123def456==; Path=/; HttpOnly',
      });
      res.end(JSON.stringify(loginStatus === 200 ? { ok: true } : { error: { message: 'Temporary failure' } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const store = {
    load: () => saved,
    save: (next) => {
      saved = next;
    },
  };
  try {
    await assert.rejects(signIn(url, url, store), /Temporary failure/);
    assert.equal(saved.email, 'owner@nigafiy.local');

    loginStatus = 200;
    const { api, created } = await signIn(url, url, store);
    assert.equal(created, false);
    assert.equal(api.session(), 'abc123def456==');
  } finally {
    server.close();
  }
});

test('homeNetwork falls back to first active non-internal private IPv4 interface when offline', async (t) => {
  const fakeSocket = new EventEmitter();
  fakeSocket.connect = () => queueMicrotask(() => fakeSocket.emit('error', Object.assign(new Error('ENETUNREACH'), { code: 'ENETUNREACH' })));
  fakeSocket.close = () => {};
  t.mock.method(dgram, 'createSocket', () => fakeSocket);
  t.mock.method(os, 'networkInterfaces', () => ({
    lo: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
    v6only: [{ family: 'IPv6', address: 'fe80::1', cidr: 'fe80::1/64', internal: false }],
    apipa: [{ family: 'IPv4', address: '169.254.12.34', cidr: '169.254.12.34/16', internal: false }],
    wan: [{ family: 'IPv4', address: '203.0.113.10', cidr: '203.0.113.10/24', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.50.42', cidr: '192.168.50.42/24', internal: false }],
    docker: [{ family: 'IPv4', address: '172.17.0.1', cidr: '172.17.0.1/16', internal: false }],
  }));
  const net = await homeNetwork();
  assert.deepEqual(net, { iface: 'Wi-Fi', address: '192.168.50.42', cidr: '192.168.50.0/24', private: true });
});

test('homeNetwork falls back on connect callback error and returns null if no private interface exists', async (t) => {
  const fakeSocket = new EventEmitter();
  fakeSocket.connect = (_port, _host, cb) => queueMicrotask(() => cb(Object.assign(new Error('EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' })));
  fakeSocket.address = () => ({ address: '0.0.0.0' });
  fakeSocket.close = () => {};
  t.mock.method(dgram, 'createSocket', () => fakeSocket);
  t.mock.method(os, 'networkInterfaces', () => ({
    lo: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
    apipa: [{ family: 'IPv4', address: '169.254.1.2', cidr: '169.254.1.2/16', internal: false }],
  }));
  assert.equal(await homeNetwork(), null);
});

test('homeNetwork prefers the routed interface when UDP probe succeeds', async (t) => {
  const fakeSocket = new EventEmitter();
  fakeSocket.connect = (_port, _host, cb) => queueMicrotask(() => cb());
  fakeSocket.address = () => ({ address: '10.0.5.9' });
  fakeSocket.close = () => {};
  t.mock.method(dgram, 'createSocket', () => fakeSocket);
  t.mock.method(os, 'networkInterfaces', () => ({
    virtual: [{ family: 'IPv4', address: '192.168.99.1', cidr: '192.168.99.1/24', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '10.0.5.9', cidr: '10.0.5.9/22', internal: false }],
  }));
  assert.deepEqual(await homeNetwork(), { iface: 'Ethernet', address: '10.0.5.9', cidr: '10.0.4.0/22', private: true });
});
