// pnpm build:launchers — one Nigafiy launcher per program (Milestone 4, spec §6.2):
// engine/bin/nigafiy-<id>.exe, built from engine/cmd/nigafiy-launcher with -X main.programID=<id>.
// The program list is the shared program table, so a new program gets its launcher automatically.
// Every binary is then asked which program it launches (`--launcher-info`) and checked.
// Nothing is installed or registered here: icons, version resources and the registry value that
// points launchers at the runtime are the Milestone 5 installers' job.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(root, 'engine');
const bin = path.join(engine, 'bin');
// Node 24 runs the TypeScript table directly (types stripped).
const { PROGRAM_IDS } = await import(pathToFileURL(path.join(root, 'packages', 'shared-types', 'src', 'programs.ts')).href);

const windows = process.platform === 'win32';
mkdirSync(bin, { recursive: true });
for (const id of PROGRAM_IDS) {
  if (!/^[a-z]+$/.test(id)) throw new Error(`refusing program id ${JSON.stringify(id)}`);
  const out = path.join(bin, `nigafiy-${id}${windows ? '.exe' : ''}`);
  // -H windowsgui: no console window flashes when a launcher is opened from the Start menu.
  const ldflags = `-s -w -X main.programID=${id}${windows ? ' -H windowsgui' : ''}`;
  execFileSync('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', out, './cmd/nigafiy-launcher'], { cwd: engine, stdio: 'inherit' });
  const info = JSON.parse(execFileSync(out, ['--launcher-info'], { encoding: 'utf8', env: { ...process.env, NIGAFIY_LAUNCHER_QUIET: '1' } }));
  if (info.program !== id) throw new Error(`${out} launches ${info.program}, expected ${id}`);
  console.log(`${path.relative(root, out)}  ${info.app_user_model_id}`);
}
