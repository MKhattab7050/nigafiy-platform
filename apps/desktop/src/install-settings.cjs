'use strict';
// The programs chosen at install time (docs/operations/installers.md, "Choose programs") and how
// this copy was installed, read from and written to the registry with Windows' own reg.exe.
//
// The installer stores REG_SZ Programs under Software\Nigafiy\Hub: HKCU for a per-user NSIS install,
// HKLM for a per-machine one and for the MSI (property PROGRAMS). The engine reads it at start and
// passes it to the stack as NIGAFIY_PROGRAMS. Apps & features "Modify" runs
// `Nigafiy.exe --choose-programs`, which opens the chooser that writes it here:
//   - per-user install: HKCU, as this user;
//   - per-machine install: HKLM through reg.exe started with the normal UAC prompt (the person sees
//     it and must accept; nothing is elevated behind their back);
//   - MSI: read-only; the administrator sets PROGRAMS through Group Policy or Intune.
const { execFile } = require('node:child_process');
const path = require('node:path');

const PROGRAMS_KEY = 'Software\\Nigafiy\\Hub';
const NSIS_GUID = '664f0038-fee2-574d-ae14-23d8a9c943e5';
const MSI_UPGRADE_CODE_PACKED = '268D7AD67E728CA408D9984B21F83BEA'; // 6DA7D862-27E7-4AC8-809D-89B4128FB3AE
const PROGRAM_IDS = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'];

/** The programs a person can choose (Hub is always installed). Names and jobs as in @nigafiy/shared-types/programs. */
const CHOICES = [
  { id: 'radar', en: 'Nigafiy Radar: see every device on the network', ar: 'Nigafiy Radar: رؤية كل جهاز على الشبكة' },
  { id: 'watch', en: 'Nigafiy Watch: monitor, and understand what went wrong', ar: 'Nigafiy Watch: المراقبة وفهم سبب المشكلة' },
  { id: 'guard', en: 'Nigafiy Guard: protect and control the network', ar: 'Nigafiy Guard: حماية الشبكة والتحكم بها' },
  { id: 'fleet', en: 'Nigafiy Fleet: manage and support company computers', ar: 'Nigafiy Fleet: إدارة أجهزة الشركة ودعمها' },
  { id: 'mind', en: 'Nigafiy Mind: knowledge, playbooks and automation', ar: 'Nigafiy Mind: المعرفة وخطط العمل والأتمتة' },
  { id: 'toolbox', en: 'Nigafiy Toolbox: quick network tools', ar: 'Nigafiy Toolbox: أدوات شبكة سريعة' },
];

/**
 * "all", or "hub,<ids>" without repeats (the engine's NormalizePrograms). Throws on an unknown id.
 * @param {string | string[]} value
 */
function normalizePrograms(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const raw = list.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  if (raw.length === 0 || (raw.length === 1 && raw[0] === 'all')) return 'all';
  const out = ['hub'];
  for (const id of raw) {
    if (!PROGRAM_IDS.includes(id)) throw new Error(`unknown program "${id}"`);
    if (!out.includes(id)) out.push(id);
  }
  return out.length === PROGRAM_IDS.length ? 'all' : out.join(',');
}

/** The ids a value selects ("all" → every choice). */
function selectedIds(value) {
  const v = normalizePrograms(value);
  return v === 'all' ? CHOICES.map((c) => c.id) : v.split(',').filter((id) => id !== 'hub');
}

/** Parses `reg query <key> /v <name>` output: the value's data, or null. */
function parseRegQuery(stdout, name) {
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ|REG_DWORD)\s+(.*)$/);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[3].trim();
  }
  return null;
}

/** Runs reg.exe (no shell; arguments as an array). Resolves { code, stdout }. */
function regExe(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? '') });
    });
  });
}

/** @param {(args: string[]) => Promise<{ code: number, stdout: string }>} run */
function makeReader(run = regExe) {
  return {
    /** The data of value `name` under `root\key` (64-bit view), or null. */
    async get(root, key, name) {
      const r = await run(['query', `${root}\\${key}`, '/v', name, '/reg:64']);
      return r.code === 0 ? parseRegQuery(r.stdout, name) : null;
    },
    async keyExists(root, key) {
      return (await run(['query', `${root}\\${key}`, '/reg:64'])).code === 0;
    },
  };
}

const sameDir = (a, b) => Boolean(a && b) && path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();

/**
 * How the copy in installDir was installed and what was chosen.
 * @returns {Promise<{ scope: 'user' | 'machine' | 'msi' | 'unknown', programs: string, raw: string | null, writable: boolean }>}
 */
async function readInstallSettings({ installDir, reader = makeReader() }) {
  let scope = 'unknown';
  if (sameDir(await reader.get('HKCU', `Software\\${NSIS_GUID}`, 'InstallLocation'), installDir)) scope = 'user';
  else if (sameDir(await reader.get('HKLM', `Software\\${NSIS_GUID}`, 'InstallLocation'), installDir)) scope = 'machine';
  else if (await reader.keyExists('HKLM', `SOFTWARE\\Classes\\Installer\\UpgradeCodes\\${MSI_UPGRADE_CODE_PACKED}`)) scope = 'msi';
  const roots = scope === 'user' ? ['HKCU'] : scope === 'unknown' ? ['HKCU', 'HKLM'] : ['HKLM'];
  let raw = null;
  for (const root of roots) {
    raw = await reader.get(root, PROGRAMS_KEY, 'Programs');
    if (raw != null) break;
  }
  let programs = 'all';
  try {
    programs = normalizePrograms(raw ?? 'all');
  } catch {
    programs = 'all'; // the engine ignores an invalid value the same way
  }
  return { scope, programs, raw, writable: scope === 'user' || scope === 'machine' };
}

/** Elevated reg.exe through the UAC prompt (per-machine installs). */
function elevatedRegExe(args) {
  const script = "$ErrorActionPreference='Stop'; $p = Start-Process -FilePath reg.exe -ArgumentList $env:NIGAFIY_REG_ARGS -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode";
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 120_000, env: { ...process.env, NIGAFIY_REG_ARGS: args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') } },
      (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? '') }),
    );
    child.stdin?.end();
  });
}

/**
 * Writes the choice for a per-user (HKCU) or per-machine (HKLM, UAC) install.
 * @returns {Promise<{ ok: true, programs: string } | { ok: false, error: string }>}
 */
async function writePrograms({ scope, ids, run = regExe, runElevated = elevatedRegExe }) {
  let value;
  try {
    value = normalizePrograms(ids);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!/^[a-z,]+$/.test(value)) return { ok: false, error: 'invalid value' };
  const args = ['add', `${scope === 'machine' ? 'HKLM' : 'HKCU'}\\${PROGRAMS_KEY}`, '/v', 'Programs', '/t', 'REG_SZ', '/d', value, '/f', '/reg:64'];
  if (scope === 'user') {
    const r = await run(args);
    return r.code === 0 ? { ok: true, programs: value } : { ok: false, error: `reg.exe exit code ${r.code}` };
  }
  if (scope === 'machine') {
    const r = await runElevated(args);
    return r.code === 0 ? { ok: true, programs: value } : { ok: false, error: r.code === 1223 ? 'cancelled' : `reg.exe exit code ${r.code} (administrator approval is needed for an install for all users)` };
  }
  return { ok: false, error: scope === 'msi' ? 'msi' : 'unknown install' };
}

module.exports = { CHOICES, PROGRAM_IDS, PROGRAMS_KEY, NSIS_GUID, MSI_UPGRADE_CODE_PACKED, normalizePrograms, selectedIds, parseRegQuery, makeReader, readInstallSettings, writePrograms };
