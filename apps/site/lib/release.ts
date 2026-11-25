// The release file the Downloads page is built from: apps/site/release/release.json.
//
// Its shape is the update manifest's payload (docs/operations/updates.md, "Manifest"): schema,
// product, version, released_at, notes_url and components [{ id, version, url, size, sha256 }],
// with more component ids (the agent for every platform, the Sensor, the APK, the MSI) and an
// optional manifest_url. No file, or no entry for a component: the page says "Not released yet".
// Write it with `pnpm --filter @nigafiy/site release:from-dist <dir> --base-url <url>`.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { T } from './i18n.ts';
import { SITE_DIR } from './paths.ts';

export type ComponentGroup = 'bundle' | 'agent' | 'sensor';

export interface ComponentInfo {
  readonly id: string;
  readonly group: ComponentGroup;
  readonly label: T;
  /** How release:from-dist recognises the file in a folder of built files. */
  readonly file: RegExp;
}

/** Every file the site can list, in display order. */
export const COMPONENTS: readonly ComponentInfo[] = [
  {
    id: 'desktop-windows-x64',
    group: 'bundle',
    label: { en: 'Windows installer (NSIS), per user or all users', ar: 'مثبّت Windows ‏(NSIS)، لمستخدم واحد أو لكل المستخدمين' },
    file: /^Nigafiy Setup \d+\.\d+\.\d+\.exe$/,
  },
  {
    id: 'desktop-msi-windows-x64',
    group: 'bundle',
    label: { en: 'Windows MSI for Group Policy and Intune (per machine)', ar: 'حزمة MSI لـ Group Policy وIntune (لكل الجهاز)' },
    file: /^Nigafiy \d+\.\d+\.\d+\.msi$/,
  },
  {
    id: 'endpoint-agent-windows-x64',
    group: 'agent',
    label: { en: 'Windows installer (64-bit)', ar: 'مثبّت Windows ‏(64 بت)' },
    file: /^Nigafiy-Endpoint-Agent-Setup-\d+\.\d+\.\d+\.exe$/,
  },
  { id: 'endpoint-agent-linux-x64', group: 'agent', label: { en: 'Linux (x86-64)', ar: 'Linux ‏(x86-64)' }, file: /^nigafiy-agent-linux-(amd64|x64)$/ },
  { id: 'endpoint-agent-linux-arm64', group: 'agent', label: { en: 'Linux (ARM64)', ar: 'Linux ‏(ARM64)' }, file: /^nigafiy-agent-linux-arm64$/ },
  { id: 'endpoint-agent-macos-x64', group: 'agent', label: { en: 'macOS (Intel)', ar: 'macOS ‏(Intel)' }, file: /^nigafiy-agent-(darwin|macos)-(amd64|x64)$/ },
  { id: 'endpoint-agent-macos-arm64', group: 'agent', label: { en: 'macOS (Apple silicon)', ar: 'macOS ‏(Apple silicon)' }, file: /^nigafiy-agent-(darwin|macos)-arm64$/ },
  { id: 'android-agent-apk', group: 'agent', label: { en: 'Android app (APK)', ar: 'تطبيق Android ‏(APK)' }, file: /^nigafiy-agent.*\.apk$|^app-release\.apk$/ },
  {
    id: 'sensor-windows-x64',
    group: 'sensor',
    label: { en: 'Windows (nigafiy-engine.exe, run as: nigafiy-engine sensor)', ar: 'Windows ‏(nigafiy-engine.exe، يُشغَّل بالأمر nigafiy-engine sensor)' },
    file: /^nigafiy-engine(-windows-(amd64|x64))?\.exe$/,
  },
  {
    id: 'sensor-linux-x64',
    group: 'sensor',
    label: { en: 'Linux x86-64 (nigafiy-engine, run as: nigafiy-engine sensor)', ar: 'Linux x86-64 ‏(nigafiy-engine، يُشغَّل بالأمر nigafiy-engine sensor)' },
    file: /^nigafiy-engine-linux-(amd64|x64)$/,
  },
];

export const COMPONENT_IDS = COMPONENTS.map((c) => c.id) as [string, ...string[]];

const SEMVER = /^\d+\.\d+\.\d+$/;
const https = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'must be an https:// URL');

export const ReleaseComponentSchema = z
  .object({
    id: z.enum(COMPONENT_IDS),
    version: z.string().regex(SEMVER, 'version must look like 1.2.3'),
    url: https,
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lower-case hex digits'),
  })
  .strict();

export const ReleaseSchema = z
  .object({
    schema: z.literal(1),
    product: z.literal('nigafiy'),
    version: z.string().regex(SEMVER, 'version must look like 1.2.3'),
    released_at: z.string().datetime(),
    notes_url: https.optional(),
    /** Where the signed manifest.json of this release is published (linked from the manifest page). */
    manifest_url: https.optional(),
    components: z.array(ReleaseComponentSchema).max(64),
  })
  .strict()
  .refine((r) => new Set(r.components.map((c) => c.id)).size === r.components.length, 'each component id may appear only once');

export type Release = z.infer<typeof ReleaseSchema>;
export type ReleaseComponent = z.infer<typeof ReleaseComponentSchema>;

export const DEFAULT_RELEASE_FILE = path.join(SITE_DIR, 'release', 'release.json');

/** Parses release JSON text; throws with every problem listed. */
export function parseRelease(text: string, where = 'release.json'): Release {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${where}: not JSON (${(err as Error).message})`);
  }
  const r = ReleaseSchema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${where} is not a valid release file:\n${lines.join('\n')}`);
  }
  return r.data;
}

/**
 * The release the site is built with: NIGAFIY_SITE_RELEASE (a path) or release/release.json.
 * null when there is no file (nothing released). An invalid file fails the build.
 */
export function loadRelease(file = process.env.NIGAFIY_SITE_RELEASE || DEFAULT_RELEASE_FILE): Release | null {
  if (!existsSync(file)) return null;
  return parseRelease(readFileSync(file, 'utf8'), file);
}

export function componentOf(release: Release | null, id: string): ReleaseComponent | null {
  return release?.components.find((c) => c.id === id) ?? null;
}

/** The file name a URL ends with (decoded), e.g. "Nigafiy Setup 1.2.3.exe". */
export function fileNameOf(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  return decodeURIComponent(last);
}

/** 123456789 → "117.7 MB" (binary units, one decimal). */
export function formatSize(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${bytes} bytes` : `${v.toFixed(1)} ${units[u]}`;
}
