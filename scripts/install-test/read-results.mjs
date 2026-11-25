#!/usr/bin/env node
// Reads what scripts/install-test/run-elevated.ps1 wrote and prints a Markdown summary
// (no elevation, reads files only). Also writes it as summary.md next to the logs.
//
//   node scripts/install-test/read-results.mjs            the latest run under .data/install-test
//   node scripts/install-test/read-results.mjs <folder>   one run's folder
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..', '..');
const root = path.join(repo, '.data', 'install-test');

/** Reads a text file written by Windows PowerShell or msiexec (UTF-8 with BOM, or UTF-16 LE). */
export function readText(file) {
  const buf = readFileSync(file);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function latestRun(dir = root) {
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir)
    .filter((d) => /^\d{8}-\d{6}$/.test(d) && statSync(path.join(dir, d)).isDirectory())
    .sort();
  return runs.length ? path.join(dir, runs.at(-1)) : null;
}

/** The outcome line of a verbose msiexec log ("... success or error status: 0."). */
export function msiOutcome(text) {
  const m = [...text.matchAll(/(Installation|Removal|Configuration) (?:success or error status|completed successfully)[^\r\n]*/g)].map((x) => x[0]);
  const status = [...text.matchAll(/success or error status: (\d+)/g)].map((x) => Number(x[1]));
  const errors = [...text.matchAll(/^.*(?:Error \d{4}|Return value 3)[^\r\n]*$/gm)].map((x) => x[0].trim()).slice(0, 10);
  return { lines: m, status: status.at(-1) ?? null, errors };
}

const unxml = (s) =>
  String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unxml(m[1]) : '';
};

/** WACK report: overall result and every test that did not pass. */
export function parseWack(xml) {
  const head = xml.match(/<REPORT\b[^>]*>/);
  const overall = head ? attr(head[0], 'OVERALL_RESULT') : '';
  const tests = [];
  for (const req of xml.matchAll(/<REQUIREMENT\b([^>]*)>([\s\S]*?)<\/REQUIREMENT>/g)) {
    const reqTitle = attr(`<x ${req[1]}>`, 'TITLE');
    for (const t of req[2].matchAll(/<TEST\b([^>]*)>([\s\S]*?)<\/TEST>/g)) {
      const name = attr(`<x ${t[1]}>`, 'NAME');
      const r = t[2].match(/<RESULT>([\s\S]*?)<\/RESULT>/);
      const result = r ? unxml(r[1]) : '';
      const messages = [...t[2].matchAll(/<MESSAGE\b([^>]*?)\/?>/g)].map((m) => attr(`<x ${m[1]}>`, 'TEXT')).filter(Boolean);
      tests.push({ requirement: reqTitle, name, result, messages });
    }
  }
  return { overall, tests };
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function summarize(dir) {
  const out = [];
  const resultsFile = path.join(dir, 'results.json');
  out.push(`# Install test results: ${path.basename(dir)}`, '');
  if (!existsSync(resultsFile)) {
    out.push(`No results.json in ${dir}: the script did not start or was stopped before its first check.`);
    return out.join('\n');
  }
  const doc = JSON.parse(readText(resultsFile));
  const results = Array.isArray(doc.results) ? doc.results : doc.results ? [doc.results] : [];
  const count = (s) => results.filter((r) => r.status === s).length;
  const fails = results.filter((r) => r.status === 'FAIL');
  out.push(`Version ${doc.version}. ${count('PASS')} pass, ${fails.length} fail, ${count('SKIP') + count('WARN')} skip/warn, ${count('INFO')} info.`, '');
  out.push(`**Overall: ${fails.length ? 'FAIL' : 'PASS'}**`, '');
  if (fails.length) {
    out.push('## Failures', '');
    for (const f of fails) out.push(`- **${f.area}**: ${f.check}${f.detail ? ` (${f.detail})` : ''}`);
    out.push('');
  }
  out.push('## All checks', '', '| Area | Check | Result | Detail |', '| --- | --- | --- | --- |');
  for (const r of results) out.push(`| ${cell(r.area)} | ${cell(r.check)} | ${r.status} | ${cell(r.detail)} |`);
  out.push('');

  const msiLogs = readdirSync(dir).filter((f) => /msi-(install|uninstall).*\.log$/.test(f) || /^cleanup-msi-uninstall.*\.log$/.test(f));
  if (msiLogs.length) {
    out.push('## msiexec logs', '');
    for (const f of msiLogs) {
      const o = msiOutcome(readText(path.join(dir, f)));
      out.push(`- \`${f}\`: status ${o.status ?? 'not found'}${o.lines.length ? `; ${o.lines.at(-1)}` : ''}`);
      for (const e of o.errors) out.push(`  - ${e}`);
    }
    out.push('');
  }

  for (const f of readdirSync(dir).filter((x) => /^wack-.*\.xml$/.test(x))) {
    const w = parseWack(readText(path.join(dir, f)));
    const bad = w.tests.filter((t) => !/^pass/i.test(t.result));
    out.push(`## WACK ${f.replace(/^wack-|\.xml$/g, '')}: ${w.overall || 'no overall result'}`, '');
    out.push(`${w.tests.length} tests, ${w.tests.length - bad.length} passed.`, '');
    if (bad.length) {
      out.push('| Requirement | Test | Result | Messages |', '| --- | --- | --- | --- |');
      for (const t of bad) out.push(`| ${cell(t.requirement)} | ${cell(t.name)} | ${cell(t.result)} | ${cell(t.messages.join(' / '))} |`);
      out.push('');
    }
  }
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : latestRun();
  if (!dir || !existsSync(dir)) {
    console.error(`No install-test run found under ${root}. Run scripts\\install-test\\run-elevated.ps1 first (elevated, by the owner).`);
    process.exit(2);
  }
  const md = summarize(dir);
  writeFileSync(path.join(dir, 'summary.md'), md);
  console.log(md);
  console.log(`\n(written to ${path.join(dir, 'summary.md')})`);
}
