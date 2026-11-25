'use strict';
// Builds a Microsoft Store MSIX package (docs/operations/microsoft-store.md).
//
//   node scripts/build-msix.cjs desktop        [--local-test] [--app-dir release/win-unpacked]
//   node scripts/build-msix.cjs quick-support  [--local-test] [--exe ../../agents/endpoint-agent/bin/nigafiy-support.exe] --version 0.1.0
//
// Uses only an already-installed Windows SDK (makeappx.exe, makepri.exe, signtool.exe): the highest
// `C:\Program Files (x86)\Windows Kits\10\bin\10.*\x64`, or NIGAFIY_WINDOWS_SDK_BIN. It downloads
// nothing.
//
// Store build (default): the identity from Partner Center (environment or .data/store/identity.json,
// scripts/msix.cjs); the package is left unsigned because the Store signs it after certification.
// --local-test: identity "Nigafiy.LocalTest.*" with the subject of the local test certificate
// (NIGAFIY_SIGN_THUMBPRINT, Cert:\CurrentUser\My), signed with it so Windows can read it back. A
// local test package is named *-local-test.msix and is never for upload.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const msix = require('./msix.cjs');

const DESKTOP = path.resolve(__dirname, '..');
const REPO = path.resolve(DESKTOP, '..', '..');

function parseArgs(argv) {
  const o = { product: argv[0], localTest: false, appDir: null, exe: null, version: null, out: path.join(DESKTOP, 'release') };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--local-test') o.localTest = true;
    else if (a === '--app-dir') o.appDir = path.resolve(next());
    else if (a === '--exe') o.exe = path.resolve(next());
    else if (a === '--version') o.version = next();
    else if (a === '--out') o.out = path.resolve(next());
    else throw new Error(`unknown option ${a}`);
  }
  if (!msix.PRODUCTS[o.product]) throw new Error('usage: build-msix.cjs desktop|quick-support [--local-test] [--app-dir <dir>] [--exe <file>] [--version x.y.z] [--out <dir>]');
  return o;
}

/** The Windows SDK tools folder (installed SDK only). */
function sdkBin(env = process.env) {
  const need = ['makeappx.exe', 'makepri.exe'];
  const ok = (dir) => need.every((f) => fs.existsSync(path.join(dir, f)));
  if (env.NIGAFIY_WINDOWS_SDK_BIN) {
    if (!ok(env.NIGAFIY_WINDOWS_SDK_BIN)) throw new Error(`NIGAFIY_WINDOWS_SDK_BIN has no makeappx.exe/makepri.exe: ${env.NIGAFIY_WINDOWS_SDK_BIN}`);
    return env.NIGAFIY_WINDOWS_SDK_BIN;
  }
  const root = path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^10\.\d+\.\d+\.\d+$/.test(d)) : [];
  versions.sort((a, b) => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
  for (const v of versions) {
    const dir = path.join(root, v, 'x64');
    if (ok(dir)) return dir;
  }
  throw new Error('No Windows SDK with makeappx.exe and makepri.exe found (install the Windows SDK, or set NIGAFIY_WINDOWS_SDK_BIN). This script never downloads one.');
}

/** Subject of the local test certificate (read-only). */
function certSubject(thumbprint) {
  const t = String(thumbprint || '').replace(/[^0-9a-fA-F]/g, '');
  if (t.length !== 40) throw new Error('--local-test needs NIGAFIY_SIGN_THUMBPRINT (the local test certificate in Cert:\\CurrentUser\\My, code-signing.md)');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$c = Get-Item -LiteralPath 'Cert:\\CurrentUser\\My\\${t}' -ErrorAction Stop; $c.Subject`], { encoding: 'utf8' }).trim();
  if (!out.startsWith('CN=')) throw new Error(`certificate ${t} has no CN= subject: ${out}`);
  return { thumbprint: t, subject: out };
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

async function writeAssets(stage, iconFile) {
  const sharp = createRequire(path.join(REPO, 'packages', 'brand', 'package.json'))('sharp');
  const svg = fs.readFileSync(iconFile);
  const dir = path.join(stage, 'Assets');
  fs.mkdirSync(dir, { recursive: true });
  for (const a of msix.ASSETS) {
    const side = Math.min(a.width, a.height);
    const size = a.width === a.height && side <= 50 ? side : Math.round(side * 0.66);
    const icon = await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
    await sharp({ create: { width: a.width, height: a.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: icon, gravity: 'center' }])
      .png()
      .toFile(path.join(dir, a.file));
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const p = msix.PRODUCTS[o.product];
  const bin = sdkBin();
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  const rawVersion = o.version || (o.product === 'desktop' ? pkg.version : null);
  if (!rawVersion) throw new Error('--version is required for quick-support (the version built into nigafiy-support.exe)');

  let cert = null;
  let identity;
  if (o.localTest) {
    cert = certSubject(process.env.NIGAFIY_SIGN_THUMBPRINT);
    identity = msix.resolveIdentity({ product: o.product, localTest: { publisher: cert.subject } });
  } else {
    const file = path.join(REPO, '.data', 'store', 'identity.json');
    const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    identity = msix.resolveIdentity({ product: o.product, json });
  }
  const version = o.localTest ? msix.localTestVersion(rawVersion) : msix.storeVersion(rawVersion);

  // Sources.
  let files;
  if (o.product === 'desktop') {
    const appDir = o.appDir || path.join(DESKTOP, 'release', 'win-unpacked');
    if (!fs.existsSync(path.join(appDir, 'Nigafiy.exe'))) throw new Error(`${appDir} has no Nigafiy.exe: run "pnpm --filter @nigafiy/desktop pack" first`);
    for (const rel of ['resources/engine/nigafiy-engine.exe', 'resources/collector/nigafiy-sensor.exe', 'resources/backend/local.mjs']) {
      if (!fs.existsSync(path.join(appDir, rel))) throw new Error(`${appDir} has no ${rel}: the bundle is incomplete`);
    }
    files = msix.appFiles(appDir, walk(appDir), 'app');
  } else {
    const exe = o.exe || path.join(REPO, 'agents', 'endpoint-agent', 'bin', 'nigafiy-support.exe');
    if (!fs.existsSync(exe)) throw new Error(`${exe} does not exist: run "pnpm build:agent" first`);
    files = [{ source: exe, target: 'nigafiy-support.exe' }];
  }

  // Staging: manifest, strings, assets, resources.pri.
  const stage = path.join(DESKTOP, 'build', 'msix', o.product);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'AppxManifest.xml'), msix.renderManifest({ product: o.product, identity, version }));
  for (const lang of msix.LANGUAGES) {
    const d = path.join(stage, 'Strings', lang);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'Resources.resw'), msix.renderResw(o.product, lang));
  }
  await writeAssets(stage, path.join(REPO, 'packages', 'brand', 'svg', p.icon));
  // MakeAppx prints one line per file (over 10 000 for the desktop app): Node's default 1 MB buffer
  // ends the run with ENOBUFS, so the output gets room and only its end is shown on an error.
  const run = (exe, args) => execFileSync(path.join(bin, exe), args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const priDir = path.join(DESKTOP, 'build', 'msix', `${o.product}-pri`);
  fs.rmSync(priDir, { recursive: true, force: true });
  fs.mkdirSync(priDir, { recursive: true });
  const priconfig = path.join(priDir, 'priconfig.xml');
  run('makepri.exe', ['createconfig', '/cf', priconfig, '/dq', msix.LANGUAGES.join('_'), '/pv', '10.0.0', '/o']);
  run('makepri.exe', ['new', '/pr', stage, '/cf', priconfig, '/mn', path.join(stage, 'AppxManifest.xml'), '/of', path.join(priDir, 'resources.pri'), '/o']);
  const staged = [
    { source: path.join(stage, 'AppxManifest.xml'), target: 'AppxManifest.xml' },
    ...msix.ASSETS.map((a) => ({ source: path.join(stage, 'Assets', a.file), target: `Assets\\${a.file}` })),
    ...fs
      .readdirSync(priDir)
      .filter((f) => f.endsWith('.pri'))
      .map((f) => ({ source: path.join(priDir, f), target: f })),
  ];
  const mapping = path.join(priDir, 'mapping.txt');
  fs.writeFileSync(mapping, msix.renderMapping({ files: [...staged, ...files] }));

  fs.mkdirSync(o.out, { recursive: true });
  const outFile = path.join(o.out, msix.outputName({ product: o.product, version: rawVersion, localTest: o.localTest }));
  console.log(`[msix] ${o.product}: ${identity.name} ${version} (${identity.publisher}), ${files.length} program files`);
  run('makeappx.exe', ['pack', '/o', '/h', 'SHA256', '/f', mapping, '/p', outFile]);
  if (cert) {
    const signtool = path.join(bin, 'signtool.exe');
    if (!fs.existsSync(signtool)) throw new Error(`no signtool.exe in ${bin}`);
    const args = ['sign', '/fd', 'SHA256', '/sha1', cert.thumbprint, '/s', 'My'];
    if (process.env.NIGAFIY_SIGN_NO_TIMESTAMP !== '1') args.push('/tr', process.env.NIGAFIY_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com', '/td', 'SHA256');
    execFileSync(signtool, [...args, outFile], { stdio: 'inherit' });
    console.log(`[msix] signed for a local test with ${cert.subject} (${cert.thumbprint})`);
  } else {
    console.log('[msix] not signed: the Microsoft Store signs the package after certification');
  }
  console.log(`[msix] wrote ${outFile} (${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB)`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[msix] ${err.stderr ? String(err.stderr).trim() || err.message : err.message}`);
    if (err.stdout) console.error(String(err.stdout).trim().split(/\r?\n/).slice(-40).join('\n'));
    process.exit(1);
  });
}

module.exports = { parseArgs, sdkBin };
