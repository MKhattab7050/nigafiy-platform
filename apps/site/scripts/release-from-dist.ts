// Writes the site's release file from a folder of built release files.
//
//   pnpm --filter @nigafiy/site release:from-dist <dir> --base-url <https://host/path/> [options]
//
//   --version <x.y.z>      the release version (default: read from "Nigafiy Setup <x.y.z>.exe" in <dir>)
//   --out <file>           where to write (default: apps/site/release/release.json)
//   --released-at <ISO>    publication time (default: now)
//   --notes-url <https>    optional release notes address
//   --manifest-url <https> where the signed manifest.json of this release is published
//
// Size and SHA-256 are computed from the files themselves. Files are recognised by name
// (lib/release.ts, COMPONENTS[].file); anything else (SHA256SUMS, manifest.json, .msix, .blockmap)
// is listed as skipped. The result is validated against the schema before it is written.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { COMPONENTS, DEFAULT_RELEASE_FILE, type Release, ReleaseSchema } from '../lib/release.ts';

export interface FromDistOptions {
  dir: string;
  baseUrl: string;
  version?: string;
  releasedAt?: string;
  notesUrl?: string;
  manifestUrl?: string;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Builds (and validates) the release from the files in opts.dir. */
export async function releaseFromDist(opts: FromDistOptions): Promise<{ release: Release; skipped: string[] }> {
  const base = new URL(opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
  if (base.protocol !== 'https:') throw new Error(`--base-url must be https:// (${opts.baseUrl})`);
  const names = readdirSync(opts.dir)
    .filter((n) => statSync(path.join(opts.dir, n)).isFile())
    .sort();
  let version = opts.version;
  if (!version) {
    const setup = names.map((n) => /^Nigafiy Setup (\d+\.\d+\.\d+)\.exe$/.exec(n)).find(Boolean);
    if (!setup) throw new Error('no --version given and no "Nigafiy Setup <x.y.z>.exe" in the folder to read it from');
    version = setup[1]!;
  }
  const components: Release['components'] = [];
  const skipped: string[] = [];
  const taken = new Map<string, string>();
  for (const name of names) {
    const c = COMPONENTS.find((k) => k.file.test(name));
    if (!c) {
      skipped.push(name);
      continue;
    }
    const other = taken.get(c.id);
    if (other) throw new Error(`two files for ${c.id}: "${other}" and "${name}"`);
    taken.set(c.id, name);
    const file = path.join(opts.dir, name);
    components.push({
      id: c.id,
      version,
      url: new URL(encodeURIComponent(name), base).href,
      size: statSync(file).size,
      sha256: await sha256File(file),
    });
  }
  if (components.length === 0) throw new Error(`no release files recognised in ${opts.dir} (skipped: ${skipped.join(', ') || 'none'})`);
  components.sort((a, b) => COMPONENTS.findIndex((c) => c.id === a.id) - COMPONENTS.findIndex((c) => c.id === b.id));
  const release = ReleaseSchema.parse({
    schema: 1,
    product: 'nigafiy',
    version,
    released_at: opts.releasedAt ?? new Date().toISOString(),
    ...(opts.notesUrl ? { notes_url: opts.notesUrl } : {}),
    ...(opts.manifestUrl ? { manifest_url: opts.manifestUrl } : {}),
    components,
  });
  return { release, skipped };
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = v;
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

if (import.meta.main) {
  try {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    const known = new Set(['base-url', 'version', 'out', 'released-at', 'notes-url', 'manifest-url']);
    for (const k of Object.keys(flags)) if (!known.has(k)) throw new Error(`unknown option --${k}`);
    const dir = positional[0];
    if (!dir || positional.length > 1) throw new Error('usage: release:from-dist <dir> --base-url <https://...> [--version x.y.z] [--out file]');
    if (!flags['base-url']) throw new Error('--base-url is required');
    const { release, skipped } = await releaseFromDist({
      dir,
      baseUrl: flags['base-url'],
      version: flags.version,
      releasedAt: flags['released-at'],
      notesUrl: flags['notes-url'],
      manifestUrl: flags['manifest-url'],
    });
    const out = path.resolve(flags.out ?? DEFAULT_RELEASE_FILE);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(release, null, 2)}\n`);
    for (const c of release.components) console.log(`[release] ${c.id.padEnd(28)} ${String(c.size).padStart(12)}  ${c.sha256}`);
    if (skipped.length) console.log(`[release] skipped (not a site download): ${skipped.join(', ')}`);
    console.log(`[release] wrote ${out}`);
  } catch (err) {
    console.error(`[release] ${(err as Error).message}`);
    process.exit(1);
  }
}
