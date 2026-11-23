#!/usr/bin/env node
// Builds a signed Nigafiy release (docs/operations/updates.md, docs/operations/installers.md).
//
//   node scripts/release/release.mjs [--version 1.2.3] [--out <folder>] [--no-msi] [--no-agent]
//       [--key <manifest key .pem> --base-url https://downloads.example.com/1.2.3/ [--notes-url https://...]
//        [--expect-public-key <base64>]]
//
// Signing is REQUIRED: this script sets NIGAFIY_REQUIRE_SIGNING=1 for itself and every build step, so
// a missing certificate (NIGAFIY_SIGN_THUMBPRINT or NIGAFIY_SIGN_PFX) stops the release before
// anything is built, and every produced .exe/.msi must then report a Valid Authenticode signature.
//
// Steps: go build collector, engine and (unless --no-agent) the endpoint agent installer; sign the Go
// binaries; electron-builder NSIS (and MSI unless --no-msi; the app, its uninstaller and both
// installers go through the signing hook); check every signature; copy the artefacts with SHA256SUMS
// into --out (default dist/release/<version>); with --key, sign the update manifest for them.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildPayload, insideRepo, publicKeyOfPem, sha256File, signPayload } from './manifest-lib.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DESKTOP = path.join(ROOT, 'apps', 'desktop');
const { signingConfig, signFiles } = require(path.join(DESKTOP, 'scripts', 'signing.cjs'));

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const opt = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].slice(name.length + 1) : args[i + 1];
};

function fail(msg) {
  console.error(`[release] ${msg}`);
  process.exit(1);
}

process.env.NIGAFIY_REQUIRE_SIGNING = '1';
try {
  signingConfig(process.env);
} catch (err) {
  fail(`${err.message} A release is always signed; see docs/operations/code-signing.md.`);
}

const desktopPkg = JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const version = opt('--version') ?? desktopPkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail('--version must look like 1.2.3');
if (version !== desktopPkg.version) {
  fail(`--version ${version} differs from apps/desktop/package.json (${desktopPkg.version}); bump the package version first so the app and its installer agree.`);
}
const outDir = path.resolve(opt('--out') ?? path.join(ROOT, 'dist', 'release', version));
const keyPath = opt('--key');
const baseUrl = opt('--base-url');
if (keyPath && !baseUrl) fail('--key needs --base-url (the https:// folder the files will be served from)');
if (keyPath && insideRepo(keyPath)) fail(`the manifest key ${path.resolve(keyPath)} is inside the repository; keep it outside.`);
if (baseUrl && !/^https:\/\//.test(baseUrl)) fail('--base-url must be https://');

const run = (cmd, argv, cwd, extraEnv = {}) =>
  execFileSync(cmd, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv }, shell: cmd === 'pnpm' || cmd === 'npx' });
const goEnv = { GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' };
const ldflags = `-s -w -X main.Version=${version}`;

/** Authenticode status of a file (the path goes in the environment, not the command line). */
function authenticode(file) {
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '$s = Get-AuthenticodeSignature -LiteralPath $env:NIGAFIY_CHECK_FILE; "$($s.Status)|$($s.SignerCertificate.Thumbprint)"'],
    { env: { ...process.env, NIGAFIY_CHECK_FILE: file }, encoding: 'utf8', windowsHide: true },
  ).trim();
  const [status, thumbprint] = out.split('|');
  return { status, thumbprint };
}

try {
  console.log(`[release] Nigafiy ${version} -> ${outDir}`);
  const collectorExe = path.join(ROOT, 'collectors', 'lan-collector', 'bin', 'nigafiy-sensor.exe');
  const engineExe = path.join(ROOT, 'engine', 'bin', 'nigafiy-engine.exe');
  run('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', collectorExe, './cmd/nigafiy-sensor'], path.join(ROOT, 'collectors', 'lan-collector'), goEnv);
  run('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', engineExe, './cmd/nigafiy-engine'], path.join(ROOT, 'engine'), goEnv);
  if (!signFiles([collectorExe, engineExe])) fail('the Go binaries were not signed');

  run('node', ['scripts/bundle-backend.mjs'], DESKTOP);
  const targets = has('--no-msi') ? ['nsis'] : ['nsis', 'msi'];
  run('pnpm', ['exec', 'electron-builder', '--win', ...targets, '--publish', 'never'], DESKTOP);

  const releaseDir = path.join(DESKTOP, desktopPkg.build?.directories?.output ?? 'release');
  const built = readdirSync(releaseDir)
    .filter((n) => n.includes(version) && /\.(exe|msi)$/i.test(n) && !n.endsWith('.__uninstaller.exe'))
    .map((n) => path.join(releaseDir, n));
  const setup = built.find((f) => f.toLowerCase().endsWith('.exe'));
  if (!setup) fail(`no NSIS installer for ${version} in ${releaseDir}`);
  if (!has('--no-msi') && !built.some((f) => f.toLowerCase().endsWith('.msi'))) fail(`no MSI for ${version} in ${releaseDir}`);

  const artefacts = [...built];
  let agentSetup;
  if (!has('--no-agent')) {
    run('node', [path.join(ROOT, 'scripts', 'installers', 'build-agent-installer.mjs'), '--version', version, '--out', path.join(ROOT, 'dist', 'installers')], ROOT);
    agentSetup = path.join(ROOT, 'dist', 'installers', `Nigafiy-Endpoint-Agent-Setup-${version}.exe`);
    artefacts.push(agentSetup);
  }

  // Every artefact (and the binaries inside the app) must carry a valid signature.
  const unpacked = path.join(releaseDir, 'win-unpacked');
  const inner = [path.join(unpacked, 'resources', 'engine', 'nigafiy-engine.exe'), path.join(unpacked, 'resources', 'collector', 'nigafiy-sensor.exe')];
  const appExe = existsSync(unpacked) ? readdirSync(unpacked).find((n) => n.toLowerCase().endsWith('.exe')) : null;
  if (appExe) inner.push(path.join(unpacked, appExe));
  const bad = [];
  for (const f of [...artefacts, ...inner.filter((f) => existsSync(f))]) {
    const sig = authenticode(f);
    console.log(`[release] ${sig.status.padEnd(12)} ${sig.thumbprint || '-'}  ${path.relative(ROOT, f)}`);
    if (sig.status !== 'Valid') bad.push(`${f}: ${sig.status}`);
  }
  if (bad.length) fail(`unsigned or invalid signatures (is the certificate trusted on this computer? scripts/signing/Install-NigafiyTrust.ps1):\n  ${bad.join('\n  ')}`);

  mkdirSync(outDir, { recursive: true });
  const sums = [];
  for (const f of artefacts) {
    const dest = path.join(outDir, path.basename(f));
    copyFileSync(f, dest);
    sums.push(`${await sha256File(dest)}  ${path.basename(f)}`);
  }
  writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  if (keyPath) {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const url = (f) => new URL(encodeURIComponent(path.basename(f)), base).href;
    const components = [{ id: 'desktop-windows-x64', file: path.join(outDir, path.basename(setup)), url: url(setup) }];
    if (agentSetup) components.push({ id: 'endpoint-agent-windows-x64', file: path.join(outDir, path.basename(agentSetup)), url: url(agentSetup) });
    const privatePem = readFileSync(keyPath, 'utf8');
    const expected = opt('--expect-public-key');
    if (expected && expected !== publicKeyOfPem(privatePem)) fail('the manifest key is not the expected one (--expect-public-key)');
    const payload = await buildPayload({ version, components, notesUrl: opt('--notes-url') });
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(signPayload(payload, privatePem), null, 2)}\n`);
    console.log(`[release] manifest.json signed (public key ${publicKeyOfPem(privatePem)})`);
  }
  for (const n of readdirSync(outDir)) console.log(`[release]   ${n}  ${statSync(path.join(outDir, n)).size} bytes`);
} catch (err) {
  fail(err.message);
}
