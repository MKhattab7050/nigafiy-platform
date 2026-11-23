import { createPublicKey, verify } from 'node:crypto';
import type { PlatformUpdatesResponse } from '@lan-detective/shared-types/programs';
import { z } from 'zod';
import { env } from '../../config/env.ts';
import { logger } from '../../infrastructure/logger.ts';

/**
 * Update check against a signed release manifest (spec §6.4).
 *
 * Wire format: `{ "payload": base64(JSON), "signature": base64(Ed25519 signature of the payload bytes) }`.
 * The payload names the release and its components with size and SHA-256. This file answers "is
 * there a newer signed release?"; `install.ts` downloads, verifies and stages a component of a
 * verified manifest and hands it to the engine on an operator's confirmation. Without a source and a
 * key the answer is "update checks are off", never "you are up to date".
 */
const MAX_MANIFEST_BYTES = 256 * 1024;
const CACHE_MS = 6 * 3600_000;

const componentSchema = z.object({
  id: z.string().min(1).max(40),
  version: z.string().min(1).max(40),
  url: z.url({ protocol: /^https$/ }),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const manifestPayloadSchema = z.object({
  schema: z.literal(1),
  product: z.literal('nigafiy'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  released_at: z.iso.datetime().nullish(),
  notes_url: z.url({ protocol: /^https$/ }).nullish(),
  components: z.array(componentSchema).max(64),
});

/** Numeric x.y.z comparison; -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface UpdateSource {
  manifestUrl?: string;
  publicKey?: string;
  currentVersion: string;
}

function publicKeyFrom(base64Raw: string) {
  const raw = Buffer.from(base64Raw, 'base64');
  if (raw.length !== 32) throw new Error('update public key must be 32 bytes (base64)');
  // SPKI DER prefix for an Ed25519 public key.
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export type ManifestPayload = z.infer<typeof manifestPayloadSchema>;
export type ManifestError = 'unreachable' | 'bad_signature' | 'bad_manifest';

/** Downloads the manifest and returns its payload only when the Ed25519 signature verifies. */
export async function fetchVerifiedManifest(manifestUrl: string, publicKey: string): Promise<{ ok: true; payload: ManifestPayload } | { ok: false; error: ManifestError }> {
  let text: string;
  try {
    const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
    if (!res.ok) return { ok: false, error: 'unreachable' };
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_MANIFEST_BYTES) return { ok: false, error: 'bad_manifest' };
    text = await res.text();
    if (text.length > MAX_MANIFEST_BYTES) return { ok: false, error: 'bad_manifest' };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'update manifest download failed');
    return { ok: false, error: 'unreachable' };
  }

  let envelope: { payload?: unknown; signature?: unknown };
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, error: 'bad_manifest' };
  }
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') return { ok: false, error: 'bad_manifest' };
  const payloadBytes = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');

  let valid = false;
  try {
    valid = verify(null, payloadBytes, publicKeyFrom(publicKey), signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'bad_signature' };

  try {
    const parsed = manifestPayloadSchema.safeParse(JSON.parse(payloadBytes.toString('utf8')));
    if (!parsed.success) return { ok: false, error: 'bad_manifest' };
    return { ok: true, payload: parsed.data };
  } catch {
    return { ok: false, error: 'bad_manifest' };
  }
}

export async function checkForUpdates(source: UpdateSource, now: Date = new Date()): Promise<PlatformUpdatesResponse> {
  const current_version = source.currentVersion;
  if (!source.manifestUrl) return { configured: false, reason: 'no_source', current_version };
  if (!source.publicKey) return { configured: false, reason: 'no_key', current_version };
  const checked_at = now.toISOString();
  const m = await fetchVerifiedManifest(source.manifestUrl, source.publicKey);
  if (!m.ok) return { configured: true, current_version, checked_at, ok: false, error: m.error };
  const payload = m.payload;
  return {
    configured: true,
    current_version,
    checked_at,
    ok: true,
    latest_version: payload.version,
    update_available: compareVersions(payload.version, current_version) > 0,
    released_at: payload.released_at ?? null,
    notes_url: payload.notes_url ?? null,
  };
}

let cache: { at: number; result: PlatformUpdatesResponse } | null = null;

export function configuredSource(currentVersion: string): UpdateSource {
  return { manifestUrl: env.NIGAFIY_UPDATE_MANIFEST_URL, publicKey: env.NIGAFIY_UPDATE_PUBLIC_KEY, currentVersion };
}

/** Cached check (6 h); `force` re-checks now. Failures are not cached for long, so a fixed network shows up soon. */
export async function cachedUpdateCheck(source: UpdateSource, force = false): Promise<PlatformUpdatesResponse> {
  const now = Date.now();
  if (!force && cache && now - cache.at < (cache.result.configured && !cache.result.ok ? 10 * 60_000 : CACHE_MS)) return cache.result;
  const result = await checkForUpdates(source);
  cache = { at: now, result };
  return result;
}

export function resetUpdateCache(): void {
  cache = null;
}
