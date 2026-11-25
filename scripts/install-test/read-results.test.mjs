import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { latestRun, msiOutcome, parseWack, readText, summarize } from './read-results.mjs';

const WACK = `<?xml version="1.0" encoding="utf-8"?>
<REPORT OVERALL_RESULT="FAIL" VERSION="10.0.26100.2454">
  <REQUIREMENTS>
    <REQUIREMENT NUMBER="1" TITLE="Clean reversible install test">
      <TEST INDEX="1" NAME="Clean reversible install" DESCRIPTION="x"><RESULT><![CDATA[PASS]]></RESULT><MESSAGES /></TEST>
    </REQUIREMENT>
    <REQUIREMENT NUMBER="2" TITLE="Package sanity test">
      <TEST INDEX="2" NAME="Blocked executables" DESCRIPTION="y"><RESULT><![CDATA[FAIL]]></RESULT>
        <MESSAGES><MESSAGE TEXT="File app\\x.exe &quot;bad&quot;" /></MESSAGES></TEST>
    </REQUIREMENT>
  </REQUIREMENTS>
</REPORT>`;

test('parseWack reads the overall result and the failing tests', () => {
  const w = parseWack(WACK);
  assert.equal(w.overall, 'FAIL');
  assert.equal(w.tests.length, 2);
  assert.deepEqual(w.tests[1], { requirement: 'Package sanity test', name: 'Blocked executables', result: 'FAIL', messages: ['File app\\x.exe "bad"'] });
});

test('msiOutcome finds the status and error lines', () => {
  const o = msiOutcome('MSI (s) (A0:B4) [10:00:00:000]: Product: Nigafiy -- Installation completed successfully.\r\nMSI (s) Windows Installer installed the product. Product Name: Nigafiy. Installation success or error status: 0.\r\n');
  assert.equal(o.status, 0);
  assert.equal(o.errors.length, 0);
  const bad = msiOutcome('Action ended 10:00: InstallFiles. Return value 3.\nInstallation success or error status: 1603.\n');
  assert.equal(bad.status, 1603);
  assert.equal(bad.errors.length, 1);
});

test('readText decodes UTF-16 LE and UTF-8 with BOM', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nigafiy-rr-'));
  try {
    const a = path.join(dir, 'a.log');
    writeFileSync(a, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('status: 0', 'utf16le')]));
    assert.equal(readText(a), 'status: 0');
    const b = path.join(dir, 'b.json');
    writeFileSync(b, `﻿{"x":1}`);
    assert.deepEqual(JSON.parse(readText(b)), { x: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summarize lists failures, msiexec logs and WACK; latestRun picks the newest folder', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nigafiy-rr-'));
  try {
    mkdirSync(path.join(root, '20261125-100000'));
    const dir = path.join(root, '20261125-110000');
    mkdirSync(dir);
    assert.equal(latestRun(root), dir);
    writeFileSync(
      path.join(dir, 'results.json'),
      `﻿${JSON.stringify({ version: '0.1.0', results: [
        { area: 'MSI', check: 'msiexec /i /qn exit code', status: 'PASS', detail: 'exit 0' },
        { area: 'MSIX desktop', check: 'Add-AppxPackage', status: 'FAIL', detail: '0x80073CF3 | x' },
        { area: 'WACK desktop', check: 'appcert.exe', status: 'SKIP', detail: '' },
      ] })}`,
    );
    writeFileSync(path.join(dir, 'msi-install.log'), 'Installation success or error status: 0.\n');
    writeFileSync(path.join(dir, 'wack-desktop.xml'), WACK);
    const md = summarize(dir);
    assert.match(md, /\*\*Overall: FAIL\*\*/);
    assert.match(md, /1 pass, 1 fail, 1 skip\/warn/);
    assert.match(md, /0x80073CF3 \\\| x/);
    assert.match(md, /`msi-install.log`: status 0/);
    assert.match(md, /## WACK desktop: FAIL/);
    assert.match(md, /Blocked executables/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
