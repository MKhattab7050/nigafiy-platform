// The update channel of a release (UX review 2026-11-26, item 14): where installed copies look for
// the signed update manifest, and the public key that manifest must verify against.
//
// The release script resolves it (--update-url / --update-public-key, else scripts/release/update-channel.json)
// and writes it into the backend bundle as update-channel.json. The launcher (scripts/local.mjs,
// copied into the bundle next to this file) hands it to the API as NIGAFIY_UPDATE_MANIFEST_URL and
// NIGAFIY_UPDATE_PUBLIC_KEY, unless the data folder's .env sets either one itself: an explicit
// `NIGAFIY_UPDATE_MANIFEST_URL=` (empty) there turns update checks off and stays off.
//
// No hosting address is built in: a release that has no channel must say so with --no-updates, and
// then the app tells the user that this copy does not check for updates.

export const CHANNEL_FILE = 'update-channel.json';
export const ENV_URL = 'NIGAFIY_UPDATE_MANIFEST_URL';
export const ENV_KEY = 'NIGAFIY_UPDATE_PUBLIC_KEY';

/** base64 of exactly 32 raw bytes (an Ed25519 public key), as NIGAFIY_UPDATE_PUBLIC_KEY holds it. */
export function isPublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === 32;
}

export function isManifestUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * The channel a release ships with.
 * @param {{ url?: string, publicKey?: string, config?: { manifest_url?: string, public_key?: string } | null,
 *           noUpdates?: boolean, signingPublicKey?: string }} o
 *   url / publicKey: command-line values (win over the config file); config: scripts/release/update-channel.json;
 *   noUpdates: --no-updates; signingPublicKey: the public key of --key, when the release also signs a manifest.
 * @returns {{ ok: true, channel: { schema: 1, manifest_url: string, public_key: string } | { schema: 1, off: true } } | { ok: false, error: string }}
 */
export function resolveReleaseChannel(o) {
  const url = o.url ?? o.config?.manifest_url;
  const publicKey = o.publicKey ?? o.config?.public_key;
  if (o.noUpdates) {
    if (o.url || o.publicKey) return { ok: false, error: '--no-updates cannot be combined with --update-url / --update-public-key' };
    return { ok: true, channel: { schema: 1, off: true } };
  }
  if (!url && !publicKey) {
    return {
      ok: false,
      error:
        'no update channel: pass --update-url https://…/manifest.json and --update-public-key <base64> (or write scripts/release/update-channel.json, see update-channel.example.json). ' +
        'To ship a release that never checks for updates, pass --no-updates; the app then tells its users so.',
    };
  }
  if (!url) return { ok: false, error: 'the update channel has a public key but no manifest URL (--update-url)' };
  if (!publicKey) return { ok: false, error: 'the update channel has a manifest URL but no public key (--update-public-key)' };
  if (!isManifestUrl(url)) return { ok: false, error: `the update manifest URL must be https:// without a user name: ${url}` };
  if (!isPublicKey(publicKey)) return { ok: false, error: 'the update public key must be base64 of 32 bytes (what scripts/release/new-update-key.mjs prints)' };
  if (o.signingPublicKey && o.signingPublicKey !== publicKey) {
    return { ok: false, error: 'the manifest key (--key) does not match the update public key the installs will trust' };
  }
  return { ok: true, channel: { schema: 1, manifest_url: url, public_key: publicKey } };
}

/** Reads update-channel.json text from a bundle; null when it is missing, malformed or says off. */
export function parseChannel(text) {
  if (typeof text !== 'string') return null;
  let c;
  try {
    c = JSON.parse(text);
  } catch {
    return null;
  }
  if (!c || c.schema !== 1 || c.off) return null;
  if (!isManifestUrl(c.manifest_url) || !isPublicKey(c.public_key)) return null;
  return { manifestUrl: c.manifest_url, publicKey: c.public_key };
}

/**
 * The variables the launcher adds to the API's environment: only those the data folder's .env does
 * not set (any line for the name, even empty, is the owner's choice and wins).
 * @param {{ manifestUrl: string, publicKey: string } | null} channel
 * @param {Record<string, string>} envFile the .env file's entries
 */
export function channelEnv(channel, envFile) {
  if (!channel) return {};
  if (Object.hasOwn(envFile, ENV_URL)) return {};
  const out = { [ENV_URL]: channel.manifestUrl };
  if (!Object.hasOwn(envFile, ENV_KEY)) out[ENV_KEY] = channel.publicKey;
  return out;
}
