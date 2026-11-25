import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { CA_RENEW_DAYS, ensureLanTls, LEAF_RENEW_DAYS, LEAF_VALIDITY_DAYS, newSerialHex, setTlsStatus, statusFromMaterial, tlsStatus } from '../src/infrastructure/lan-tls.ts';
import { lanAddress } from '../src/common/http.ts';
import { app, CSRF, newAccount, setRole } from './helpers.ts';

const DAY = 86_400_000;
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ld-lan-tls-'));
  dirs.push(d);
  return path.join(d, 'tls');
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** icacls listing of a path (Windows), without the trailing summary line. */
const windowsAcl = (target: string) =>
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [target], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => !/Successfully processed|Failed processing/.test(l))
    .join('\n');

const id = { hostnames: ['nigafiy-box', 'localhost'], ipAddresses: ['127.0.0.1', '192.168.50.10', '::1'] };

describe('built-in LAN TLS', () => {
  it('creates a local CA and a server certificate covering the hostname, LAN addresses and localhost', () => {
    const dir = tempDir();
    const m = ensureLanTls(dir, id);
    expect(m.action).toBe('created_ca');
    expect(m.caFingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(m.dnsNames.sort()).toEqual(['localhost', 'nigafiy-box']);
    expect(m.ipAddresses.sort()).toEqual(['127.0.0.1', '192.168.50.10', '::1'].sort());

    const ca = new X509Certificate(readFileSync(m.caFile));
    expect(ca.ca).toBe(true);
    expect(ca.fingerprint256).toBe(m.caFingerprint256);
    const chain = readFileSync(m.certFile, 'utf8');
    expect(chain.match(/BEGIN CERTIFICATE/g)).toHaveLength(2); // server certificate, then the CA
    const leaf = new X509Certificate(chain);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.keyUsage).toContain('1.3.6.1.5.5.7.3.1'); // serverAuth
    const days = (leaf.validToDate.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(LEAF_VALIDITY_DAYS - 1);
    expect(days).toBeLessThanOrEqual(LEAF_VALIDITY_DAYS);

    if (process.platform !== 'win32') {
      for (const f of ['ca.pem', 'ca-key.pem', 'server.pem', 'server-key.pem']) expect(statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } else {
      // Protected DACL: no inherited entries, and only the current user, SYSTEM and Administrators.
      for (const target of [dir, ...['ca.pem', 'ca-key.pem', 'server.pem', 'server-key.pem'].map((f) => path.join(dir, f))]) {
        const acl = windowsAcl(target);
        expect(acl).not.toMatch(/\(I\)/);
        expect(acl).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users|S-1-1-0|S-1-5-11|S-1-5-32-545/i);
        const entries = acl.split(/\r?\n/).filter((l) => /:\(/.test(l));
        expect(entries).toHaveLength(3);
        expect(acl.toLowerCase()).toContain(os.userInfo().username.toLowerCase());
      }
    }
  });

  it('gives files copied into the folder by hand the same owner-only access', () => {
    const dir = tempDir();
    ensureLanTls(dir, id);
    const stray = path.join(dir, 'server-key.pem');
    if (process.platform === 'win32') {
      // widen the key file the way a careless copy would, then expect the next start to tighten it
      execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [stray, '/inheritance:e', '/grant', '*S-1-5-32-545:R'], { stdio: 'ignore' });
      expect(windowsAcl(stray)).toMatch(/\(I\)|Users/);
    } else {
      chmodSync(stray, 0o644);
    }
    expect(ensureLanTls(dir, id).action).toBe('loaded');
    if (process.platform === 'win32') {
      expect(windowsAcl(stray)).not.toMatch(/\(I\)|BUILTIN\\Users/);
    } else {
      expect(statSync(stray).mode & 0o777).toBe(0o600);
    }
  });

  it('keeps everything on restart, re-issues the server certificate (same CA, same pin) when names change or expiry nears', () => {
    const dir = tempDir();
    const first = ensureLanTls(dir, id);
    const again = ensureLanTls(dir, id);
    expect(again.action).toBe('loaded');
    expect(again.leafFingerprint256).toBe(first.leafFingerprint256);

    const moved = ensureLanTls(dir, { ...id, ipAddresses: [...id.ipAddresses, '10.0.0.7'] });
    expect(moved.action).toBe('issued_leaf');
    expect(moved.caFingerprint256).toBe(first.caFingerprint256);
    expect(moved.ipAddresses).toContain('10.0.0.7');

    const soon = new Date(moved.leafNotAfter.getTime() - (LEAF_RENEW_DAYS - 1) * DAY);
    const renewed = ensureLanTls(dir, { ...id, ipAddresses: moved.ipAddresses, now: soon });
    expect(renewed.action).toBe('issued_leaf');
    expect(renewed.caFingerprint256).toBe(first.caFingerprint256);
    expect(renewed.leafFingerprint256).not.toBe(moved.leafFingerprint256);
    expect(renewed.leafNotAfter.getTime()).toBeGreaterThan(moved.leafNotAfter.getTime());

    const notYet = new Date(renewed.leafNotAfter.getTime() - (LEAF_RENEW_DAYS + 5) * DAY);
    expect(ensureLanTls(dir, { ...id, ipAddresses: moved.ipAddresses, now: notYet }).action).toBe('loaded');
  });

  it('replaces the CA (new pin) only when the CA itself nears expiry', () => {
    const dir = tempDir();
    const first = ensureLanTls(dir, id);
    const late = new Date(first.caNotAfter.getTime() - (CA_RENEW_DAYS - 1) * DAY);
    const next = ensureLanTls(dir, { ...id, now: late });
    expect(next.action).toBe('created_ca');
    expect(next.caFingerprint256).not.toBe(first.caFingerprint256);
    const leaf = new X509Certificate(readFileSync(next.certFile, 'utf8'));
    expect(leaf.checkIssued(new X509Certificate(readFileSync(next.caFile)))).toBe(true);
  });

  it('writes serial numbers in minimal DER form (no illegal leading zero byte)', () => {
    for (let i = 0; i < 512; i++) {
      const s = newSerialHex();
      expect(s).toMatch(/^[0-7][0-9a-f]{31}$/);
      expect(s.startsWith('00')).toBe(false);
    }
  });

  it('re-issues a server certificate that the CA did not sign', () => {
    const a = tempDir();
    const b = tempDir();
    ensureLanTls(a, id);
    const other = ensureLanTls(b, id);
    // put B's server certificate next to A's CA
    copyFileSync(other.certFile, path.join(a, 'server.pem'));
    copyFileSync(other.keyFile, path.join(a, 'server-key.pem'));
    expect(ensureLanTls(a, id).action).toBe('issued_leaf');
  });

  it('serves HTTPS that a client trusting only the local CA accepts for each name, and a stranger refuses', async () => {
    const dir = tempDir();
    const m = ensureLanTls(dir, id);
    const server = https.createServer({ cert: readFileSync(m.certFile), key: readFileSync(m.keyFile) }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const connect = (opts: tls.ConnectionOptions) =>
      new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect({ host: '127.0.0.1', port, ...opts }, () => resolve(s));
        s.on('error', reject);
      });
    try {
      const ca = readFileSync(m.caFile);
      for (const servername of ['localhost', 'nigafiy-box']) {
        const s = await connect({ ca, servername });
        expect(s.authorized).toBe(true);
        expect(s.getPeerCertificate(true).issuerCertificate.fingerprint256).toBe(m.caFingerprint256);
        s.destroy();
      }
      const byIp = await connect({ ca }); // no SNI, checked against the IP address SAN
      expect(byIp.authorized).toBe(true);
      byIp.destroy();
      await expect(connect({ servername: 'localhost' })).rejects.toThrow(); // system roots only
      await expect(connect({ ca, servername: 'not-this-box' })).rejects.toThrow(/altnames|Hostname/i);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('GET /system/tls reports the CA pin to any signed-in role, and nothing without a session', async () => {
    const dir = tempDir();
    const m = ensureLanTls(dir, id);
    const before = tlsStatus();
    setTlsStatus(statusFromMaterial(m, 4443, '0.0.0.0', null));
    try {
      const acct = await newAccount('lantls');
      await setRole(acct.email, acct.organizationId, 'viewer');
      const r = await acct.agent.get('/api/v1/system/tls');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ mode: 'auto', https_port: 4443, pin_kind: 'ca', pin_sha256: m.caFingerprint256 });
      expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE KEY|BEGIN/);
      expect((await request(app).get('/api/v1/system/tls')).status).toBe(401);
    } finally {
      setTlsStatus(before);
    }
  });

  it('hands phones and other computers the LAN HTTPS address, not localhost, when the page is opened on this computer', async () => {
    const dir = tempDir();
    const m = ensureLanTls(dir, id);
    const before = tlsStatus();
    setTlsStatus(statusFromMaterial(m, 4443, '0.0.0.0', null));
    try {
      const acct = await newAccount('lanurl');
      const r = await acct.agent.post('/api/v1/endpoints').set(CSRF).send({ site_id: acct.siteId, name: 'Owner phone', platform: 'android' });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ server_url: 'https://192.168.50.10:4443', server_url_source: 'lan', tls_pin_sha256: m.caFingerprint256 });
      // Reached through a real LAN name: that address is kept.
      const proxied = await acct.agent.post('/api/v1/endpoints').set(CSRF).set('Host', 'nigafiy-box:4100').send({ site_id: acct.siteId, name: 'Phone 2', platform: 'android' });
      expect(proxied.body).toMatchObject({ server_url: 'http://nigafiy-box:4100', server_url_source: 'request' });
    } finally {
      setTlsStatus(before);
    }
  });

  it('picks a home-network IPv4 over virtual adapters, link-local and loopback', () => {
    expect(lanAddress(['127.0.0.1', '169.254.3.4', '172.20.0.1', '10.0.0.7', '192.168.1.147', '::1'])).toBe('192.168.1.147');
    expect(lanAddress(['172.20.0.1', '10.0.0.7'])).toBe('10.0.0.7');
    expect(lanAddress(['::1', 'fe80::1', 'fd00::5'])).toBe('fd00::5');
    expect(lanAddress(['127.0.0.1', '::1'])).toBeNull();
  });
});
