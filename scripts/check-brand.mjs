#!/usr/bin/env node
// Fails when the old product name is left anywhere a person could see it (Milestone 2, the rename).
//
//   pnpm check:brand
//
// It looks for "LAN Detective" (any case) and "lan-detective" in every file git tracks or would
// track. Two kinds of exceptions, both listed in docs/architecture/naming.md:
//   - whole files that describe history or hold the compatibility tables (FILES below);
//   - lines that carry an identifier kept on purpose because it is persisted or on the wire
//     (KEPT below: router rule labels and tags, the owner value, the webhook signature header ...).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const OLD = /lan[ -]detective/i;

/** Whole files allowed to mention the old name. Globs: `**` any path, `*` within one segment. */
export const FILES = [
  // History: plans, specs and the status log describe what happened under the old name.
  'docs/superpowers/**',
  'docs/roadmap/status.md',
  // The decision table itself, and this check.
  'docs/architecture/naming.md',
  'scripts/check-brand.mjs',
  'scripts/check-brand.test.mjs',
  // Compatibility code: the legacy names it still reads, and its tests.
  'apps/api/src/config/env-compat.ts',
  'apps/desktop/src/data-dir.cjs',
  'apps/desktop/test/data-dir.test.cjs',
  'apps/desktop/test/installer-identity.test.cjs',
  'engine/internal/engine/compat.go',
  'engine/internal/engine/engine_test.go',
  'engine/internal/update/update.go',
  'engine/internal/update/update_test.go',
  // Importing an install from before the rename: the old folders, uninstaller and profile it looks for.
  'apps/desktop/installer/nigafiy.nsh',
  'apps/desktop/src/legacy-import.cjs',
  'apps/desktop/test/legacy-import.test.cjs',
  'docs/operations/installers.md',
  'docs/operations/real-hardware-checklist.md',
];

/** Lines allowed anywhere: identifiers kept because they are persisted or on the wire. */
export const KEPT = [
  // Router rule label written on routers (router.ProductRulePrefix / PORT_FORWARD_PREFIX) and
  // the texts that quote it to the operator.
  /LAN Detective: /,
  /LAN Detective:[”»]/,
  // Router-side tags and the ownership value in the collector protocol.
  /lan-detective:/,
  /['"`]lan-detective['"`]/,
  /owner(?:\.|: |=)['"`]?lan-detective/,
  /\.lan-detective['"`]/,
  /lan-detective\|administrator/,
  // Webhook signature header (receivers verify it).
  /X-LAN-Detective-Signature/i,
  // The desktop auto-start launcher from before the rename, removed when found.
  /'LAN Detective\.vbs'/,
];

/** SQL migrations are never rewritten: the old name may stay in their comments only. */
const SQL_COMMENT = /^\s*--/;

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const FILE_RES = FILES.map(globToRegExp);

/** Problems in one file's text: [{ line, text }]. */
export function scan(file, text) {
  if (FILE_RES.some((re) => re.test(file))) return [];
  const migration = /^apps\/api\/src\/database\/migrations\/.*\.sql$/.test(file);
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!OLD.test(line)) continue;
    if (migration && SQL_COMMENT.test(line)) continue;
    // Remove every kept identifier, then look again: the line passes only if nothing else is left.
    let rest = line;
    for (const re of KEPT) rest = rest.replace(new RegExp(re.source, `${re.flags.replace('g', '')}g`), '');
    if (OLD.test(rest)) out.push({ line: i + 1, text: line.trim().slice(0, 160) });
  }
  return out;
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

if (import.meta.main) {
  // Old names in file names count too (for example a "Start LAN Detective.cmd").
  const problems = [];
  for (const file of trackedFiles()) {
    if (OLD.test(file) && !FILE_RES.some((re) => re.test(file))) problems.push(`${file}: the file name has the old product name`);
    let buf;
    try {
      buf = readFileSync(path.join(root, file));
    } catch {
      continue; // deleted in the working tree
    }
    if (buf.includes(0)) continue; // binary
    for (const p of scan(file, buf.toString('utf8'))) problems.push(`${file}:${p.line}: ${p.text}`);
  }
  if (problems.length) {
    console.error(`check:brand: the old product name is still used in ${problems.length} place(s):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('Rename it to Nigafiy, or, if it is persisted or on the wire, add it to docs/architecture/naming.md and the KEPT list in scripts/check-brand.mjs.');
    process.exit(1);
  }
  console.log('check:brand: no leftover "LAN Detective" / "lan-detective" outside the allow-list');
}
