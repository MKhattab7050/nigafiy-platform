// Shared by new-update-key.mjs and sign-manifest.mjs (and the API tests, which check that a
// manifest made here verifies in apps/api/src/modules/platform/updates.ts).
//
// Manifest wire format: { "payload": base64(JSON), "signature": base64(Ed25519(payload bytes)) }.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** True when p is the repository or inside it (keys must never live there). */
export function insideRepo(p, root = REPO_ROOT) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** A new Ed25519 key pair: the private key as PKCS#8 PEM, the public key as base64 of its 32 raw bytes. */
export function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: rawPublicKey(publicKey) };
}

/** base64 of the 32 raw bytes of an Ed25519 public key (what NIGAFIY_UPDATE_PUBLIC_KEY holds). */
export function rawPublicKey(keyObject) {
  return keyObject.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

export function publicKeyOfPem(privatePem) {
  return rawPublicKey(createPublicKey(createPrivateKey(privatePem)));
}

export async function sha256File(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/**
 * Builds and validates the payload. components: [{ id, file, url, version? }]; size and SHA-256 are
 * read from each file.
 */
export async function buildPayload({ version, components, notesUrl, releasedAt }) {
  if (!VERSION_RE.test(version ?? '')) throw new Error('--version must look like 1.2.3');
  if (!Array.isArray(components) || components.length === 0) throw new Error('at least one --component is needed');
  if (components.length > 64) throw new Error('at most 64 components');
  const https = (u, what) => {
    let url;
    try {
      url = new URL(u);
    } catch {
      throw new Error(`${what} is not a URL: ${u}`);
    }
    if (url.protocol !== 'https:') throw new Error(`${what} must be https:// (${u})`);
    return url.href;
  };
  const seen = new Set();
  const out = [];
  for (const c of components) {
    if (!ID_RE.test(c.id ?? '')) throw new Error(`component id ${JSON.stringify(c.id)} must be lower-case letters, digits and '-'`);
    if (seen.has(c.id)) throw new Error(`component ${c.id} given twice`);
    seen.add(c.id);
    const st = statSync(c.file);
    if (!st.isFile() || st.size === 0) throw new Error(`${c.file} is not a non-empty file`);
    out.push({ id: c.id, version: c.version ?? version, url: https(c.url, `component ${c.id} URL`), size: st.size, sha256: await sha256File(c.file) });
  }
  const payload = { schema: 1, product: 'nigafiy', version, released_at: releasedAt ?? new Date().toISOString(), components: out };
  if (notesUrl) payload.notes_url = https(notesUrl, '--notes-url');
  if (Number.isNaN(Date.parse(payload.released_at))) throw new Error('--released-at must be an ISO date-time');
  payload.released_at = new Date(payload.released_at).toISOString();
  return payload;
}

/** Signs the payload and checks the signature with the key's own public half before returning. */
export function signPayload(payload, privatePem) {
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key must be an Ed25519 private key (new-update-key.mjs)');
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = sign(null, bytes, key);
  if (!verify(null, bytes, createPublicKey(key), signature)) throw new Error('signature self-check failed');
  return { payload: bytes.toString('base64'), signature: signature.toString('base64') };
}

/** Parses "id=file@https://url" (the last '@' separates the URL). */
export function parseComponentArg(arg) {
  const eq = arg.indexOf('=');
  const at = arg.lastIndexOf('@');
  if (eq <= 0 || at <= eq + 1) throw new Error(`--component must be id=path@https://url (got ${arg})`);
  return { id: arg.slice(0, eq), file: path.resolve(arg.slice(eq + 1, at)), url: arg.slice(at + 1) };
}
