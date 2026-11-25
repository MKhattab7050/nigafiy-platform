// The release file schema and release:from-dist (real files in a temporary folder).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { COMPONENTS, componentOf, fileNameOf, formatSize, loadRelease, parseRelease } from '../../lib/release.ts';
import { releaseFromDist } from '../../scripts/release-from-dist.ts';

const SITE = path.resolve(import.meta.dirname, '../..');
const FIXTURE = path.join(SITE, 'tests', 'fixtures', 'release.json');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nigafiy-site-release-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('release.json schema', () => {
  it('accepts the fixture and reads its components', () => {
    const r = parseRelease(readFileSync(FIXTURE, 'utf8'));
    assert.equal(r.version, '9.8.7');
    assert.equal(componentOf(r, 'desktop-windows-x64')?.size, 123456789);
    assert.equal(componentOf(r, 'sensor-linux-x64'), null);
    assert.equal(fileNameOf(componentOf(r, 'desktop-windows-x64')!.url), 'Nigafiy Setup 9.8.7.exe');
  });

  it('is the update manifest payload shape (schema, product, version, released_at, components with id/version/url/size/sha256)', () => {
    const payload = {
      schema: 1,
      product: 'nigafiy',
      version: '1.2.3',
      released_at: '2026-11-23T10:00:00.000Z',
      notes_url: 'https://example.com/changelog/1.2.3',
      components: [{ id: 'desktop-windows-x64', version: '1.2.3', url: 'https://downloads.example.com/1.2.3/a.exe', size: 1, sha256: 'a'.repeat(64) }],
    };
    assert.doesNotThrow(() => parseRelease(JSON.stringify(payload)));
  });

  it('accepts a release with no components (every row reads "Not released yet")', () => {
    const r = parseRelease(JSON.stringify({ schema: 1, product: 'nigafiy', version: '0.1.0', released_at: '2026-11-25T00:00:00Z', components: [] }));
    assert.equal(r.components.length, 0);
  });

  const base = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const bad: [string, (r: ReturnType<typeof base>) => void, RegExp][] = [
    ['an http:// URL', (r) => (r.components[0].url = 'http://downloads.example.com/a.exe'), /https/],
    ['a short hash', (r) => (r.components[0].sha256 = 'abc'), /sha256/],
    ['an upper-case hash', (r) => (r.components[0].sha256 = 'A'.repeat(64)), /sha256/],
    ['a zero size', (r) => (r.components[0].size = 0), /size/],
    ['an unknown component id', (r) => (r.components[0].id = 'desktop-linux'), /id/],
    ['a duplicate id', (r) => r.components.push({ ...r.components[0] }), /only once/],
    ['an unknown field', (r) => (r.extra = true), /extra|Unrecognized/i],
    ['a bad version', (r) => (r.version = 'v1'), /version/],
    ['another product', (r) => (r.product = 'other'), /product/],
  ];
  for (const [what, change, msg] of bad) {
    it(`refuses ${what}`, () => {
      const r = base();
      change(r);
      assert.throws(() => parseRelease(JSON.stringify(r)), msg);
    });
  }

  it('refuses text that is not JSON', () => {
    assert.throws(() => parseRelease('{nope'), /not JSON/);
  });

  it('loadRelease: no file means nothing released; a bad file fails', () => {
    assert.equal(loadRelease(path.join(tmp, 'missing.json')), null);
    const badFile = path.join(tmp, 'bad.json');
    writeFileSync(badFile, '{"schema":2}');
    assert.throws(() => loadRelease(badFile), /not a valid release file/);
  });

  it('every component id is unique and the update manifest ids are kept', () => {
    const ids = COMPONENTS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ['desktop-windows-x64', 'endpoint-agent-windows-x64']) assert.ok(ids.includes(id), id);
  });

  it('formats sizes', () => {
    assert.equal(formatSize(512), '512 bytes');
    assert.equal(formatSize(2860410), '2.7 MB');
    assert.equal(formatSize(123456789), '117.7 MB');
  });
});

describe('release:from-dist', () => {
  const dist = path.join(tmp, 'dist');
  const files: Record<string, Buffer> = {
    'Nigafiy Setup 1.4.0.exe': Buffer.from('nsis installer bytes'),
    'Nigafiy 1.4.0.msi': Buffer.from('msi bytes, a little longer'),
    'Nigafiy-Endpoint-Agent-Setup-1.4.0.exe': Buffer.from('agent'),
    'nigafiy-agent-linux-amd64': Buffer.from('elf'),
    'nigafiy-agent-darwin-arm64': Buffer.from('mach-o'),
    'nigafiy-agent-0.1.0.apk': Buffer.from('apk'),
    'nigafiy-engine-linux-amd64': Buffer.from('engine'),
    SHA256SUMS: Buffer.from('x'),
    'manifest.json': Buffer.from('{}'),
  };

  it('computes the real size and SHA-256 of each file and maps names to components', async () => {
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(dist)}, { recursive: true })`]);
    for (const [n, b] of Object.entries(files)) writeFileSync(path.join(dist, n), b);
    const { release, skipped } = await releaseFromDist({ dir: dist, baseUrl: 'https://downloads.example.com/1.4.0', releasedAt: '2026-11-25T12:00:00.000Z' });
    assert.equal(release.version, '1.4.0');
    assert.deepEqual(skipped, ['SHA256SUMS', 'manifest.json']);
    const byId = Object.fromEntries(release.components.map((c) => [c.id, c]));
    assert.deepEqual(Object.keys(byId), [
      'desktop-windows-x64',
      'desktop-msi-windows-x64',
      'endpoint-agent-windows-x64',
      'endpoint-agent-linux-x64',
      'endpoint-agent-macos-arm64',
      'android-agent-apk',
      'sensor-linux-x64',
    ]);
    const setup = byId['desktop-windows-x64']!;
    assert.equal(setup.size, files['Nigafiy Setup 1.4.0.exe']!.length);
    assert.equal(setup.sha256, sha(files['Nigafiy Setup 1.4.0.exe']!));
    assert.equal(setup.url, 'https://downloads.example.com/1.4.0/Nigafiy%20Setup%201.4.0.exe');
    assert.equal(byId['android-agent-apk']!.sha256, sha('apk'));
  });

  it('the command line writes a release.json that the site accepts', () => {
    const out = path.join(tmp, 'out', 'release.json');
    const stdout = execFileSync(
      process.execPath,
      [path.join(SITE, 'scripts', 'release-from-dist.ts'), dist, '--base-url', 'https://downloads.example.com/1.4.0/', '--out', out, '--manifest-url', 'https://downloads.example.com/1.4.0/manifest.json'],
      { encoding: 'utf8' },
    );
    assert.match(stdout, /wrote/);
    const r = loadRelease(out)!;
    assert.equal(r.components.length, 7);
    assert.equal(r.manifest_url, 'https://downloads.example.com/1.4.0/manifest.json');
  });

  it('refuses an http:// base URL, an empty folder and two files for one component', async () => {
    await assert.rejects(releaseFromDist({ dir: dist, baseUrl: 'http://downloads.example.com/' }), /https/);
    const empty = mkdtempSync(path.join(tmp, 'empty-'));
    await assert.rejects(releaseFromDist({ dir: empty, baseUrl: 'https://h.example.com/', version: '1.0.0' }), /no release files/);
    await assert.rejects(releaseFromDist({ dir: empty, baseUrl: 'https://h.example.com/' }), /no --version/);
    writeFileSync(path.join(dist, 'nigafiy-agent-linux-x64'), 'second linux agent');
    await assert.rejects(releaseFromDist({ dir: dist, baseUrl: 'https://h.example.com/' }), /two files for endpoint-agent-linux-x64/);
  });

  it('the command line exits 1 with a reason on bad arguments', () => {
    assert.throws(() => execFileSync(process.execPath, [path.join(SITE, 'scripts', 'release-from-dist.ts'), dist], { stdio: 'pipe' }), (e: { status: number; stderr: Buffer }) => e.status === 1 && /--base-url is required/.test(String(e.stderr)));
  });
});
