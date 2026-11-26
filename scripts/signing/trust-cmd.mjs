#!/usr/bin/env node
// One double-click file that makes a Windows PC trust the Nigafiy code-signing certificate.
//
//   node scripts/signing/trust-cmd.mjs --cer <nigafiy-code-signing.cer> --out <Trust-Nigafiy.cmd>
//
// The PUBLIC certificate is embedded in the .cmd (base64). Double-clicking it asks Windows for
// administrator rights, checks the certificate (no private key, code signing, not expired) and adds
// it to LocalMachine\Root and LocalMachine\TrustedPublisher, the same as Install-NigafiyTrust.ps1.
// "Trust-Nigafiy.cmd /remove" takes the trust away again; "/check" only says
// whether it is trusted (no administrator needed). Every release puts this file at the top of the
// release folder; the separate .cer and .ps1 go into for-IT\ (for Group Policy).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';

export const TRUST_CMD_NAME = 'Trust-Nigafiy.cmd';
export const FOR_IT_DIR = 'for-IT';

/** Throws when the bytes are not a single public X.509 certificate (DER or PEM). Returns DER bytes. */
export function certificateDer(bytes) {
  const text = bytes.toString('latin1');
  if (/PRIVATE KEY/.test(text)) throw new Error('the certificate file contains a private key; use the public .cer only');
  const cert = new X509Certificate(bytes);
  return Buffer.from(cert.raw);
}

/** The .cmd text (ASCII, CRLF) with the certificate embedded. */
export function buildTrustCmd(cerBytes) {
  const der = certificateDer(cerBytes);
  const b64 = der.toString('base64').replace(/(.{76})/g, '$1\r\n').trim();
  const batch = [
    '@echo off',
    'setlocal',
    'rem Nigafiy: makes this computer trust programs signed by your organisation (public certificate inside).',
    'rem Double-click to trust. "Trust-Nigafiy.cmd /remove" (as administrator) takes the trust away.',
    'set "NIGAFIY_SELF=%~f0"',
    'set "NIGAFIY_ARG=%~1"',
    'if /i "%~1"=="/check" goto run',
    'net session >nul 2>&1',
    'if errorlevel 1 (',
    '  echo Asking Windows for administrator rights...',
    '  powershell -NoProfile -Command "$a = @(); if ($env:NIGAFIY_ARG) { $a = @($env:NIGAFIY_ARG) }; if ($a.Count) { Start-Process -FilePath $env:NIGAFIY_SELF -ArgumentList $a -Verb RunAs } else { Start-Process -FilePath $env:NIGAFIY_SELF -Verb RunAs }"',
    '  exit /b',
    ')',
    ':run',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = [IO.File]::ReadAllText($env:NIGAFIY_SELF); $m = \'#NIGAFIY\' + \'-POWERSHELL\'; Invoke-Expression $t.Substring($t.LastIndexOf($m))"',
    'echo.',
    'pause',
    'exit /b',
    '',
  ];
  const ps = [
    '#NIGAFIY-POWERSHELL (everything below runs in PowerShell)',
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $remove = $env:NIGAFIY_ARG -match \'^[/-]remove$\'',
    '  $check = $env:NIGAFIY_ARG -match \'^[/-]check$\'',
    "  $b64 = @'",
    b64,
    "'@",
    "  $bytes = [Convert]::FromBase64String(($b64 -replace '\\s', ''))",
    '  $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2(,$bytes)',
    "  if ($cert.HasPrivateKey) { throw 'This certificate contains a private key.' }",
    "  $codeSigning = $cert.EnhancedKeyUsageList | Where-Object { $_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }",
    "  if (-not $codeSigning) { throw 'This is not a code-signing certificate.' }",
    '  if (-not $remove -and $cert.NotAfter -lt (Get-Date)) { throw "This certificate expired on $($cert.NotAfter)." }',
    "  foreach ($name in 'Root', 'TrustedPublisher') {",
    "    $store = New-Object Security.Cryptography.X509Certificates.X509Store($name, 'LocalMachine')",
    "    $store.Open($(if ($check) { 'ReadOnly' } else { 'ReadWrite' }))",
    '    try {',
    '      $found = $store.Certificates.Find(\'FindByThumbprint\', $cert.Thumbprint, $false).Count -gt 0',
    '      if ($check) {',
    "        Write-Host \"LocalMachine\\$name : $(if ($found) { 'trusted' } else { 'NOT trusted' })\"",
    '      } elseif ($remove) {',
    '        if ($found) { $store.Remove($cert); Write-Host "Removed from LocalMachine\\$name." } else { Write-Host "Not in LocalMachine\\$name." }',
    '      } elseif ($found) {',
    '        Write-Host "Already trusted in LocalMachine\\$name."',
    '      } else {',
    '        $store.Add($cert); Write-Host "Trusted in LocalMachine\\$name."',
    '      }',
    '    } finally { $store.Close() }',
    '  }',
    '  Write-Host ""',
    '  Write-Host "Certificate: $($cert.Subject)  ($($cert.Thumbprint)), valid until $($cert.NotAfter.ToString(\'yyyy-MM-dd\'))"',
    '  if ($check) { }',
    '  elseif ($remove) { Write-Host \'Done. Nigafiy programs are no longer trusted on this computer.\' }',
    '  else { Write-Host \'Done. You can now run the Nigafiy installers; Windows shows "Nigafiy" as the publisher.\' }',
    '} catch {',
    '  Write-Host ""',
    '  Write-Host "Failed: $($_.Exception.Message)" -ForegroundColor Red',
    '}',
    '',
  ];
  const text = [...batch, ...ps].join('\r\n');
  if (/[^\x00-\x7f]/.test(text)) throw new Error('Trust-Nigafiy.cmd must be plain ASCII');
  return text;
}

export function writeTrustCmd(cerPath, outPath) {
  writeFileSync(outPath, buildTrustCmd(readFileSync(cerPath)), 'ascii');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const cer = opt('--cer');
  const out = opt('--out');
  if (!cer || !out) {
    console.error('usage: node scripts/signing/trust-cmd.mjs --cer <file.cer> --out <Trust-Nigafiy.cmd>');
    process.exit(2);
  }
  writeTrustCmd(cer, out);
  console.log(`[trust-cmd] wrote ${out}`);
}
