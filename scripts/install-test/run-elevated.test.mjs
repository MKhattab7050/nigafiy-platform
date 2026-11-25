import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-elevated.ps1');

// Pulls one function out of run-elevated.ps1 with the PowerShell parser (the script itself is never run:
// it needs an elevated shell) and calls it in Windows PowerShell 5.1, the shell the owner uses.
function runFunction(name, body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nigafiy-re-'));
  try {
    const probe = path.join(dir, 'probe.ps1');
    writeFileSync(
      probe,
      [
        '$ErrorActionPreference = "Stop"',
        `$LogDir = '${dir}'`,
        `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT}', [ref]$null, [ref]$null)`,
        `$fn = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq '${name}' }, $true)`,
        '. ([scriptblock]::Create($fn.Extent.Text))',
        body,
      ].join('\r\n'),
    );
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], { encoding: 'utf8' }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Invoke-Logged returns the exit code and stdout of the program it ran', { skip: process.platform !== 'win32' }, () => {
  // Run 20261125-095600: ExitCode came back empty because the process handle was never opened.
  const out = runFunction('Invoke-Logged', "$r = Invoke-Logged 'cmd.exe' @('/d', '/c', 'echo hello& exit 3') 'probe' 30; \"$($r.code)|$($r.timedOut)|$(([string]$r.stdout).Trim())\"");
  assert.equal(out.split(/\r?\n/).pop(), '3|False|hello');
});

test('Invoke-Logged reports exit 0 as 0, not as empty', { skip: process.platform !== 'win32' }, () => {
  const out = runFunction('Invoke-Logged', "$r = Invoke-Logged 'cmd.exe' @('/d', '/c', 'exit 0') 'probe' 30; \"[$($r.code)] $($r.code -eq 0)\"");
  assert.equal(out.split(/\r?\n/).pop(), '[0] True');
});
