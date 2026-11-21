'use strict';
// Free Authenticode signing for the Windows build. Used two ways:
//   - electron-builder's custom `win.signtoolOptions.sign` hook (exports.default), for the app .exe,
//     the uninstaller and the NSIS installer;
//   - `node scripts/signing.cjs <files...>` before packaging, for the Go binaries in extraResources.
// It drives scripts/signing/Sign-NigafiyFiles.ps1 (built-in PowerShell, no signtool or paid service).
//
// Configuration (environment):
//   NIGAFIY_SIGN_THUMBPRINT     certificate in Cert:\CurrentUser\My (New-NigafiySigningCert.ps1)
//   NIGAFIY_SIGN_PFX            or a .pfx file; its password in NIGAFIY_SIGN_PFX_PASSWORD
//   NIGAFIY_SIGN_TIMESTAMP_URL  RFC 3161 server (default DigiCert's free one)
//   NIGAFIY_SIGN_NO_TIMESTAMP=1 sign without a timestamp
//   NIGAFIY_REQUIRE_SIGNING=1   fail instead of building unsigned when nothing is configured
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'signing', 'Sign-NigafiyFiles.ps1');

/** Reads the signing settings; returns null when signing is not configured. */
function signingConfig(env = process.env) {
  const thumbprint = (env.NIGAFIY_SIGN_THUMBPRINT || '').replace(/[^0-9a-fA-F]/g, '');
  const pfx = env.NIGAFIY_SIGN_PFX || '';
  const timestampUrl =
    env.NIGAFIY_SIGN_NO_TIMESTAMP === '1' ? '' : (env.NIGAFIY_SIGN_TIMESTAMP_URL ?? 'http://timestamp.digicert.com');
  if (thumbprint && thumbprint.length !== 40) throw new Error('NIGAFIY_SIGN_THUMBPRINT must be a 40-character SHA-1 thumbprint.');
  if (!thumbprint && !pfx) {
    if (env.NIGAFIY_REQUIRE_SIGNING === '1') {
      throw new Error('NIGAFIY_REQUIRE_SIGNING=1 but neither NIGAFIY_SIGN_THUMBPRINT nor NIGAFIY_SIGN_PFX is set.');
    }
    return null;
  }
  if (timestampUrl && !/^https?:\/\/[^\s]+$/i.test(timestampUrl)) throw new Error('NIGAFIY_SIGN_TIMESTAMP_URL must be an http(s) URL.');
  return thumbprint ? { thumbprint, timestampUrl } : { pfx: path.resolve(pfx), timestampUrl };
}

/** PowerShell arguments to sign one file (no secrets: the PFX password stays in the environment). */
function psArgs(cfg, file) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
  if (cfg.thumbprint) args.push('-Thumbprint', cfg.thumbprint);
  else args.push('-PfxPath', cfg.pfx);
  if (cfg.timestampUrl) args.push('-TimestampUrl', cfg.timestampUrl);
  else args.push('-NoTimestamp');
  args.push('-Path', file);
  return args;
}

let warned = false;
function signFiles(files, env = process.env, run = execFileSync) {
  const cfg = signingConfig(env);
  if (!cfg) {
    if (!warned) {
      console.warn('[signing] No certificate configured: building UNSIGNED. See docs/operations/code-signing.md.');
      warned = true;
    }
    return false;
  }
  for (const f of files) if (!fs.existsSync(f)) throw new Error(`[signing] File to sign does not exist: ${f}`);
  for (const f of files) run('powershell.exe', psArgs(cfg, f), { stdio: 'inherit', env });
  return true;
}

/** electron-builder custom sign hook. It calls once per hash algorithm; Authenticode SHA-256 only. */
async function sign(configuration) {
  if (configuration.hash && configuration.hash !== 'sha256') return;
  signFiles([configuration.path]);
}

module.exports = sign;
module.exports.default = sign;
module.exports.signingConfig = signingConfig;
module.exports.psArgs = psArgs;
module.exports.signFiles = signFiles;

if (require.main === module) {
  const files = process.argv.slice(2).map((f) => path.resolve(f));
  if (files.length === 0) {
    console.error('usage: node scripts/signing.cjs <file> [file...]');
    process.exit(2);
  }
  try {
    signFiles(files);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
