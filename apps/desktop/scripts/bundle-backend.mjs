// Prepares everything the installed desktop app needs to run Nigafiy on its own:
//   build/backend/local.mjs      the launcher (same one `pnpm local` uses)
//   build/backend/.env.example   template; the app writes its own .env with fresh secrets on first run
//   build/backend/api/           API + database runner with production dependencies (pnpm deploy)
//   build/backend/web/           standalone Next.js server (no dev dependencies)
// electron-builder copies build/backend into the installer as resources/backend.
// The packaged app runs all of it with Electron's own Node (ELECTRON_RUN_AS_NODE), so the person
// installing it needs nothing else.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const desktop = path.resolve(import.meta.dirname, '..');
const root = path.resolve(desktop, '../..');
const out = path.join(desktop, 'build', 'backend');
const win = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const spawnOpts = { cwd: root, stdio: 'inherit', ...opts, env: { ...process.env, ...opts.env } };
  const r = win
    ? spawnSync([cmd, ...args].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(' '), { ...spawnOpts, shell: true })
    : spawnSync(cmd, args, spawnOpts);
  if (r.status !== 0) {
    console.error(`failed: ${cmd} ${args.join(' ')}`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. The engine, which is also the Sensor (`nigafiy-engine sensor`; docs/architecture/engine-sensor.md),
//    bundled as resources/engine. CGO off and main.Version stamped with the desktop version, as in the
//    release build (scripts/release/release.mjs builds and signs it again after this script).
const desktopVersion = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
run('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.Version=${desktopVersion}`, '-o', path.join(root, 'engine/bin', win ? 'nigafiy-engine.exe' : 'nigafiy-engine'), './cmd/nigafiy-engine'], {
  cwd: path.join(root, 'engine'),
  env: { CGO_ENABLED: '0' },
});

// 2. API with production dependencies only, as plain folders (no pnpm symlinks inside the installer).
run('pnpm', ['--filter', '@nigafiy/api', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', path.join(out, 'api')]);
rmSync(path.join(root, 'apps/api/apps'), { recursive: true, force: true });
for (const dir of ['tests', 'vitest.config.ts']) rmSync(path.join(out, 'api', dir), { recursive: true, force: true });

// 2b. The API imports a few runtime values (ROLES, DEVICE_TRUSTS, ...) from the shared types package. In the
// repository Node strips its TypeScript; inside node_modules it refuses to, so the bundle gets compiled JavaScript.
const sharedOut = path.join(out, 'api', 'node_modules', '@nigafiy', 'shared-types');
rmSync(sharedOut, { recursive: true, force: true });
run('pnpm', ['--filter', '@nigafiy/shared-types', 'exec', 'tsc', '-p', '.', '--noEmit', 'false', '--outDir', path.join(sharedOut, 'dist')]);
writeFileSync(
  path.join(sharedOut, 'package.json'),
  JSON.stringify({ name: '@nigafiy/shared-types', private: true, type: 'module', main: 'dist/index.js', exports: { '.': './dist/index.js', './markdown': './dist/markdown.js', './programs': './dist/programs.js' } }, null, 2),
);

// 3. Web app as a standalone server. The API address is fixed at build time (Next.js rewrites).
run('pnpm', ['--filter', '@nigafiy/web', 'build'], { env: { NEXT_OUTPUT: 'standalone', API_INTERNAL_URL: 'http://127.0.0.1:47100', NEXT_TELEMETRY_DISABLED: '1' } });
const web = path.join(root, 'apps/web');
const standalone = path.join(web, '.next', 'standalone');
if (!existsSync(path.join(standalone, 'apps', 'web', 'server.js'))) {
  console.error('standalone build missing apps/web/server.js');
  process.exit(1);
}
// dereference: the standalone node_modules are pnpm symlinks; the installer needs real files.
cpSync(standalone, path.join(out, 'web'), { recursive: true, dereference: true });
// pnpm keeps each package's dependencies next to it inside node_modules/.pnpm and links them in.
// With the links turned into real folders that no longer resolves, so hoist every package into a
// plain node_modules at the top of the web bundle (where Node's lookup from apps/web finds it).
const pnpmStore = path.join(out, 'web', 'node_modules', '.pnpm');
if (existsSync(pnpmStore)) {
  for (const entry of readdirSync(pnpmStore)) {
    const modules = path.join(pnpmStore, entry, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const name of readdirSync(modules)) {
      const names = name.startsWith('@') ? readdirSync(path.join(modules, name)).map((n) => `${name}/${n}`) : [name];
      for (const pkg of names) {
        const target = path.join(out, 'web', 'node_modules', pkg);
        if (!existsSync(target)) cpSync(path.join(modules, pkg), target, { recursive: true, dereference: true });
      }
    }
  }
  rmSync(pnpmStore, { recursive: true, force: true });
}
cpSync(path.join(web, '.next', 'static'), path.join(out, 'web', 'apps', 'web', '.next', 'static'), { recursive: true });
if (existsSync(path.join(web, 'public'))) cpSync(path.join(web, 'public'), path.join(out, 'web', 'apps', 'web', 'public'), { recursive: true });
// The dev server must not pick up the standalone build output next time.
rmSync(standalone, { recursive: true, force: true });

// 4. Launcher and env template.
cpSync(path.join(root, 'scripts', 'local.mjs'), path.join(out, 'local.mjs'));
cpSync(path.join(root, '.env.example'), path.join(out, '.env.example'));
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));

console.log(`\nbackend bundle ready: ${path.relative(root, out)}`);
