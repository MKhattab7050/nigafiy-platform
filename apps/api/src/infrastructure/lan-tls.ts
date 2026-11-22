import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TlsStatus } from '@lan-detective/shared-types';
import forge from 'node-forge';

/**
 * Built-in LAN TLS: a local certificate authority and a server certificate it signs, kept in the
 * data folder, for the HTTPS listener when no TLS_CERT_FILE / TLS_KEY_FILE is supplied.
 *
 * Why a CA and not one self-signed certificate: collectors and agents pin the CA's SHA-256
 * fingerprint. The server certificate can then be re-issued (before it expires, or when this
 * computer's names / addresses change) without re-enrolling anything; only a new CA changes the pin.
 *
 * Node's crypto can create keys but not X.509 certificates, so certificates are built with
 * node-forge (pure JavaScript, no native code); keys come from Node's crypto.
 *
 * Files (directory 0700, files 0600 where the OS honours POSIX modes):
 *   ca.pem / ca-key.pem          the local CA (10 years)
 *   server.pem / server-key.pem  server certificate + CA (chain) and its key (397 days)
 */

export const CA_VALIDITY_DAYS = 3650;
export const LEAF_VALIDITY_DAYS = 397;
/** Re-issue the server certificate when it has fewer days left than this. */
export const LEAF_RENEW_DAYS = 30;
/** Replace the CA (which changes the pin) when it has fewer days left than this. */
export const CA_RENEW_DAYS = 365;

const DAY = 86_400_000;

export interface LanTlsMaterial {
  dir: string;
  certFile: string;
  keyFile: string;
  caFile: string;
  /** Colon-separated upper-case SHA-256 of the CA certificate (DER): what collectors and agents pin. */
  caFingerprint256: string;
  leafFingerprint256: string;
  leafNotAfter: Date;
  caNotAfter: Date;
  dnsNames: string[];
  ipAddresses: string[];
  /** What this call did. */
  action: 'loaded' | 'issued_leaf' | 'created_ca';
}

export interface LanTlsOptions {
  hostnames?: string[];
  ipAddresses?: string[];
  now?: Date;
}

/** This computer's names and addresses for the certificate: hostname, localhost, every interface address. */
export function localIdentity(): { hostnames: string[]; ipAddresses: string[] } {
  const host = os.hostname().toLowerCase();
  const hostnames = [...new Set([host, 'localhost'].filter((h) => /^[a-z0-9.-]+$/.test(h)))];
  const ips = new Set<string>(['127.0.0.1', '::1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv6' && a.address.startsWith('fe80')) continue; // link-local needs a zone id
      ips.add(a.address);
    }
  }
  return { hostnames, ipAddresses: [...ips] };
}

function writeSecret(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: POSIX modes do not apply; the data folder's ACL (user profile) protects it */
  }
}

const serial = () => `00${randomBytes(16).toString('hex')}`; // positive, 128 random bits

function newKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    forgePublic: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
  };
}

function createCa(now: Date): { certPem: string; keyPem: string } {
  const keys = newKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.forgePublic;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(now.getTime() - 5 * 60_000);
  cert.validity.notAfter = new Date(now.getTime() + CA_VALIDITY_DAYS * DAY);
  const name = [
    { name: 'commonName', value: `Nigafiy local CA (${os.hostname().slice(0, 40)})` },
    { name: 'organizationName', value: 'Nigafiy' },
  ];
  cert.setSubject(name);
  cert.setIssuer(name);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  const caKey = forge.pki.privateKeyFromPem(keys.privatePem);
  cert.sign(caKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
}

function issueLeaf(caCertPem: string, caKeyPem: string, dnsNames: string[], ips: string[], now: Date): { certPem: string; keyPem: string } {
  const ca = forge.pki.certificateFromPem(caCertPem);
  const keys = newKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.forgePublic;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(now.getTime() - 5 * 60_000);
  const caEnd = ca.validity.notAfter.getTime();
  cert.validity.notAfter = new Date(Math.min(now.getTime() + LEAF_VALIDITY_DAYS * DAY, caEnd));
  cert.setSubject([{ name: 'commonName', value: dnsNames[0] ?? 'localhost' }]);
  cert.setIssuer(ca.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [...dnsNames.map((value) => ({ type: 2, value })), ...ips.map((ip) => ({ type: 7, ip }))] },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: ca.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(caKeyPem), forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: keys.privatePem };
}

/** Names / addresses the certificate covers (from its subjectAltName). */
function sansOf(cert: X509Certificate): { dns: string[]; ips: string[] } {
  const dns: string[] = [];
  const ips: string[] = [];
  for (const part of (cert.subjectAltName ?? '').split(/,\s*/)) {
    if (part.startsWith('DNS:')) dns.push(part.slice(4).toLowerCase());
    else if (part.startsWith('IP Address:')) ips.push(normalizeIp(part.slice(11)));
  }
  return { dns, ips };
}

function normalizeIp(ip: string): string {
  if (!ip.includes(':')) return ip;
  // X509Certificate prints IPv6 fully expanded with upper-case hex; compare in one canonical form.
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return ip.toLowerCase();
  }
}

/**
 * Loads the LAN TLS material from `dir`, creating or renewing what is needed:
 *  - no CA, or the CA expires within CA_RENEW_DAYS → new CA and server certificate (the pin changes);
 *  - the server certificate is missing, expires within LEAF_RENEW_DAYS, is not signed by the CA, or
 *    does not cover every current hostname / address → new server certificate (the pin stays).
 */
export function ensureLanTls(dir: string, opts: LanTlsOptions = {}): LanTlsMaterial {
  const now = opts.now ?? new Date();
  const id = localIdentity();
  const dnsNames = [...new Set((opts.hostnames ?? id.hostnames).map((h) => h.toLowerCase()))];
  const ips = [...new Set((opts.ipAddresses ?? id.ipAddresses).map(normalizeIp))];
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows */
  }
  const caFile = path.join(dir, 'ca.pem');
  const caKeyFile = path.join(dir, 'ca-key.pem');
  const certFile = path.join(dir, 'server.pem');
  const keyFile = path.join(dir, 'server-key.pem');

  let action: LanTlsMaterial['action'] = 'loaded';
  let caPem = existsSync(caFile) && existsSync(caKeyFile) ? readFileSync(caFile, 'utf8') : null;
  let caKeyPem = caPem ? readFileSync(caKeyFile, 'utf8') : null;
  if (caPem && new X509Certificate(caPem).validToDate.getTime() - now.getTime() < CA_RENEW_DAYS * DAY) caPem = null;
  if (!caPem || !caKeyPem) {
    const ca = createCa(now);
    caPem = ca.certPem;
    caKeyPem = ca.keyPem;
    writeSecret(caKeyFile, caKeyPem);
    writeSecret(caFile, caPem);
    action = 'created_ca';
  }
  const caCert = new X509Certificate(caPem);

  let leafOk = action === 'loaded' && existsSync(certFile) && existsSync(keyFile);
  if (leafOk) {
    const leaf = new X509Certificate(readFileSync(certFile, 'utf8'));
    const sans = sansOf(leaf);
    leafOk =
      leaf.checkIssued(caCert) &&
      leaf.verify(caCert.publicKey) &&
      leaf.validToDate.getTime() - now.getTime() >= LEAF_RENEW_DAYS * DAY &&
      dnsNames.every((d) => sans.dns.includes(d)) &&
      ips.every((ip) => sans.ips.includes(ip));
  }
  if (!leafOk) {
    const leaf = issueLeaf(caPem, caKeyPem, dnsNames, ips, now);
    writeSecret(keyFile, leaf.keyPem);
    writeSecret(certFile, leaf.certPem + caPem); // chain: server certificate, then the CA
    if (action === 'loaded') action = 'issued_leaf';
  }

  const leafCert = new X509Certificate(readFileSync(certFile, 'utf8'));
  const sans = sansOf(leafCert);
  return {
    dir,
    certFile,
    keyFile,
    caFile,
    caFingerprint256: caCert.fingerprint256,
    leafFingerprint256: leafCert.fingerprint256,
    leafNotAfter: leafCert.validToDate,
    caNotAfter: caCert.validToDate,
    dnsNames: sans.dns,
    ipAddresses: sans.ips,
    action,
  };
}

// ── What the running process serves (read by GET /system/tls and the enrollment responses) ──

export type { TlsStatus };

let status: TlsStatus = {
  mode: 'off',
  https_port: null,
  https_host: null,
  pin_sha256: null,
  pin_kind: null,
  leaf_not_after: null,
  ca_not_after: null,
  dns_names: [],
  ip_addresses: [],
  last_renewed_at: null,
};

export function setTlsStatus(next: TlsStatus): void {
  status = next;
}
export function tlsStatus(): TlsStatus {
  return status;
}

export function statusFromMaterial(m: LanTlsMaterial, port: number, host: string | null, renewedAt: Date | null): TlsStatus {
  return {
    mode: 'auto',
    https_port: port,
    https_host: host,
    pin_sha256: m.caFingerprint256,
    pin_kind: 'ca',
    leaf_not_after: m.leafNotAfter.toISOString(),
    ca_not_after: m.caNotAfter.toISOString(),
    dns_names: m.dnsNames,
    ip_addresses: m.ipAddresses,
    last_renewed_at: renewedAt?.toISOString() ?? null,
  };
}
