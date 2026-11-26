#!/usr/bin/env node
// Builds a signed Nigafiy release (docs/operations/updates.md, docs/operations/installers.md).
//
//   node scripts/release/release.mjs [--version 1.2.3] [--out <folder>] [--no-msi] [--no-agent] [--no-android]
//       [--android-cert-sha256 <hex>]
//       [--key <manifest key .pem> --base-url https://downloads.example.com/1.2.3/ [--notes-url https://...]
//        [--expect-public-key <base64>]]
//       [--update-url https://…/manifest.json --update-public-key <base64> | --no-updates]
//       [--trust-cer <public signing certificate .cer>]
//
// Update channel (UX review item 14): every release says where its installs look for updates. It comes
// from --update-url / --update-public-key, else scripts/release/update-channel.json (copy
// update-channel.example.json; it holds nothing secret). No address is built in: without a channel the
// release stops, unless --no-updates says this release never checks (the app then tells its users so).
// The channel goes into the backend bundle as update-channel.json (scripts/update-channel.mjs).
//
// Signing is REQUIRED: this script sets NIGAFIY_REQUIRE_SIGNING=1 for itself and every build step, so
// a missing certificate (NIGAFIY_SIGN_THUMBPRINT or NIGAFIY_SIGN_PFX) stops the release before
// anything is built, and every produced .exe/.msi must then report a Valid Authenticode signature.
//
// Steps: go build the engine (which is also the Sensor, `nigafiy-engine sensor`) and (unless --no-agent) the endpoint agent installer; sign the Go
// binaries; electron-builder NSIS (and MSI unless --no-msi; the app, its uninstaller and both
// installers go through the signing hook); check every signature; (unless --no-android) build the
// Android agent and check its APK (release key, not debug; versionName = the release; not debuggable;
// --android-cert-sha256 or NIGAFIY_ANDROID_CERT_SHA256 pins the certificate); copy the artefacts with SHA256SUMS
// into --out (default dist/release/<version>); with --key, sign the update manifest for them.
// Every release also gets Trust-Nigafiy.cmd (one double-click file with the public certificate inside,
// scripts/signing/trust-cmd.mjs) and for-IT\ with the .cer and Install-NigafiyTrust.ps1 for Group Policy.
// The certificate comes from --trust-cer or .data/signing/nigafiy-code-signing.cer and must be the
// signing certificate (same thumbprint as NIGAFIY_SIGN_THUMBPRINT when that is set).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { checkReleaseApk, releaseApkName } from '../android/release-apk.mjs';
import { CHANNEL_FILE, resolveReleaseChannel } from '../update-channel.mjs';
import { buildPayload, insideRepo, publicKeyOfPem, sha256File, signPayload } from './manifest-lib.mjs';
import { FOR_IT_DIR, TRUST_CMD_NAME, buildTrustCmd } from '../signing/trust-cmd.mjs';
import { X509Certificate } from 'node:crypto';

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

// The update channel, checked before anything is built.
const channelConfigPath = path.join(import.meta.dirname, 'update-channel.json');
let channelConfig = null;
if (existsSync(channelConfigPath)) {
  try {
    channelConfig = JSON.parse(readFileSync(channelConfigPath, 'utf8'));
  } catch (err) {
    fail(`${channelConfigPath} is not valid JSON: ${err.message}`);
  }
}
const channelResult = resolveReleaseChannel({
  url: opt('--update-url'),
  publicKey: opt('--update-public-key'),
  config: channelConfig,
  noUpdates: has('--no-updates'),
  signingPublicKey: keyPath ? publicKeyOfPem(readFileSync(keyPath, 'utf8')) : undefined,
});
if (!channelResult.ok) fail(channelResult.error);
const updateChannel = channelResult.channel;

// The public certificate for Trust-Nigafiy.cmd, checked before anything is built.
const trustCerPath = path.resolve(opt('--trust-cer') ?? path.join(ROOT, '.data', 'signing', 'nigafiy-code-signing.cer'));
if (!existsSync(trustCerPath)) fail(`the public certificate ${trustCerPath} is missing (--trust-cer <file.cer>); every release ships ${TRUST_CMD_NAME}.`);
const trustCerBytes = readFileSync(trustCerPath);
let trustCmdText;
try {
  trustCmdText = buildTrustCmd(trustCerBytes);
} catch (err) {
  fail(`${trustCerPath}: ${err.message}`);
}
{
  const want = (process.env.NIGAFIY_SIGN_THUMBPRINT || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const have = new X509Certificate(trustCerBytes).fingerprint.replace(/:/g, '').toUpperCase();
  if (want && want !== have) fail(`${trustCerPath} (thumbprint ${have}) is not the signing certificate ${want}.`);
}

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
  // One executable for the engine and the Sensor (docs/architecture/engine-sensor.md); main.Version
  // stamps both (the Sensor reports it to the server).
  // bundle-backend.mjs builds the engine too, so build and sign it here AFTER that script: otherwise its
  // unsigned build would replace the signed one inside the package.
  run('node', ['scripts/bundle-backend.mjs'], DESKTOP);
  writeFileSync(path.join(DESKTOP, 'build', 'backend', CHANNEL_FILE), `${JSON.stringify(updateChannel, null, 2)}\n`);
  console.log(updateChannel.off ? '[release] updates: OFF (--no-updates); installs will say they do not check for updates' : `[release] updates: ${updateChannel.manifest_url}`);
  const engineExe = path.join(ROOT, 'engine', 'bin', 'nigafiy-engine.exe');
  run('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', engineExe, './cmd/nigafiy-engine'], path.join(ROOT, 'engine'), goEnv);
  if (!signFiles([engineExe])) fail('the engine executable was not signed');

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
  const inner = [path.join(unpacked, 'resources', 'engine', 'nigafiy-engine.exe')];
  // No stale second Sensor program in the package (it would also keep old firewall rules useful).
  if (existsSync(path.join(unpacked, 'resources', 'collector'))) fail(`${path.join(unpacked, 'resources', 'collector')} exists: the Sensor is nigafiy-engine.exe now; remove the folder and build again`);
  const appExe = existsSync(unpacked) ? readdirSync(unpacked).find((n) => n.toLowerCase().endsWith('.exe')) : null;
  if (appExe) inner.push(path.join(unpacked, appExe));
  const bad = [];
  for (const f of [...artefacts, ...inner.filter((f) => existsSync(f))]) {
    const sig = authenticode(f);
    console.log(`[release] ${sig.status.padEnd(12)} ${sig.thumbprint || '-'}  ${path.relative(ROOT, f)}`);
    if (sig.status !== 'Valid') bad.push(`${f}: ${sig.status}`);
  }
  if (bad.length) fail(`unsigned or invalid signatures (is the certificate trusted on this computer? scripts/signing/Install-NigafiyTrust.ps1):\n  ${bad.join('\n  ')}`);

  // The Android agent: built and checked here, so a release never goes out without it (or with a debug build).
  let androidApk = null;
  if (!has('--no-android')) {
    run('node', [path.join(ROOT, 'scripts', 'android', 'build.mjs')], ROOT);
    const apk = checkReleaseApk({ version, expectCertSha256: opt('--android-cert-sha256') ?? process.env.NIGAFIY_ANDROID_CERT_SHA256 });
    if (apk.problems.length) fail(`the Android APK cannot ship:\n  ${apk.problems.join('\n  ')}`);
    console.log(`[release] Android ok  ${apk.signer.sha256}  ${apk.signer.dn}  versionName ${apk.badging.versionName}`);
    androidApk = apk.apk;
  }

  mkdirSync(outDir, { recursive: true });
  const sums = [];
  const copies = artefacts.map((f) => [f, path.basename(f)]);
  if (androidApk) copies.push([androidApk, releaseApkName(version)]);
  for (const [f, name] of copies) {
    const dest = path.join(outDir, name);
    copyFileSync(f, dest);
    sums.push(`${await sha256File(dest)}  ${name}`);
  }
  writeFileSync(path.join(outDir, TRUST_CMD_NAME), trustCmdText, 'ascii');
  sums.push(`${await sha256File(path.join(outDir, TRUST_CMD_NAME))}  ${TRUST_CMD_NAME}`);
  mkdirSync(path.join(outDir, FOR_IT_DIR), { recursive: true });
  copyFileSync(trustCerPath, path.join(outDir, FOR_IT_DIR, 'nigafiy-code-signing.cer'));
  copyFileSync(path.join(ROOT, 'scripts', 'signing', 'Install-NigafiyTrust.ps1'), path.join(outDir, FOR_IT_DIR, 'Install-NigafiyTrust.ps1'));
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
