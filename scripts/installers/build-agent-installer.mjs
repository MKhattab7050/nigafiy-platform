#!/usr/bin/env node
// Builds the Nigafiy Endpoint Agent installer (docs/operations/installers.md).
//
//   node scripts/installers/build-agent-installer.mjs [--version 1.2.3] [--out dist/installers]
//
// 1. go build agents/endpoint-agent for windows/amd64 with main.Version set;
// 2. signs nigafiy-agent.exe through apps/desktop/scripts/signing.cjs (the same free Authenticode
//    hook the desktop build uses; NIGAFIY_REQUIRE_SIGNING=1 makes a missing certificate an error);
// 3. compiles packaging/endpoint-agent/endpoint-agent.nsi with makensis (NIGAFIY_MAKENSIS, PATH, or
//    the copy electron-builder keeps in its cache);
// 4. signs the installer.
// It never runs the installer.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const { signFiles } = require(path.join(ROOT, 'apps', 'desktop', 'scripts', 'signing.cjs'));

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].slice(name.length + 1) : args[i + 1];
};

const version = opt('--version') ?? JSON.parse(readFileSync(path.join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('--version must look like 1.2.3');
  process.exit(2);
}
const outDir = path.resolve(opt('--out') ?? path.join(ROOT, 'dist', 'installers'));

/** makensis: NIGAFIY_MAKENSIS, then PATH, then electron-builder's cache. */
export function findMakensis(env = process.env) {
  if (env.NIGAFIY_MAKENSIS) {
    if (!existsSync(env.NIGAFIY_MAKENSIS)) throw new Error(`NIGAFIY_MAKENSIS=${env.NIGAFIY_MAKENSIS} does not exist`);
    return env.NIGAFIY_MAKENSIS;
  }
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    const p = path.join(dir, 'makensis.exe');
    if (dir && existsSync(p)) return p;
  }
  const cache = path.join(env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((n) => n.startsWith('nsis-') && !n.includes('resources')).sort().reverse()) {
      const base = path.join(cache, d);
      for (const sub of ['', ...readdirSync(base)]) {
        const p = path.join(base, sub, 'makensis.exe');
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('makensis.exe not found: install NSIS 3, set NIGAFIY_MAKENSIS, or run the desktop dist build once (electron-builder caches it).');
}

try {
  const binDir = path.join(ROOT, 'agents', 'endpoint-agent', 'bin');
  mkdirSync(binDir, { recursive: true });
  const agentExe = path.join(binDir, 'nigafiy-agent.exe');
  console.log(`[agent-installer] go build nigafiy-agent ${version}`);
  execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.Version=${version}`, '-o', agentExe, './cmd/nigafiy-agent'], {
    cwd: path.join(ROOT, 'agents', 'endpoint-agent'),
    stdio: 'inherit',
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  });
  signFiles([agentExe]);

  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `Nigafiy-Endpoint-Agent-Setup-${version}.exe`);
  const makensis = findMakensis();
  console.log(`[agent-installer] ${makensis}`);
  execFileSync(
    makensis,
    [
      '-V2',
      `-DVERSION=${version}`,
      `-DAGENT_EXE=${agentExe}`,
      `-DOUTFILE=${outFile}`,
      `-DICON=${path.join(ROOT, 'packages', 'brand', 'ico', 'agent.ico')}`,
      path.join(ROOT, 'packaging', 'endpoint-agent', 'endpoint-agent.nsi'),
    ],
    { stdio: 'inherit' },
  );
  // NSIS 3.0.4 writes the uninstaller at install time, so it is not signed (documented gap).
  signFiles([outFile]);
  console.log(`[agent-installer] ${outFile}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
