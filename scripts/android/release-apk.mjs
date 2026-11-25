// Checks the Android agent's release APK before it goes into a Nigafiy release (scripts/release/release.mjs):
// signed (and verifying), not with the Android debug key, not debuggable, and carrying the release's
// version. The parsing is pure (tested in release-apk.test.mjs); checkReleaseApk runs aapt2 and apksigner.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const win = process.platform === 'win32';
export const ROOT = resolve(import.meta.dirname, '..', '..');
export const RELEASE_APK = join(ROOT, 'agents', 'android-agent', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
export const UNSIGNED_APK = join(ROOT, 'agents', 'android-agent', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');

/** The file name the APK has in a release folder. */
export const releaseApkName = (version) => `Nigafiy-Android-Agent-${version}.apk`;

/** What `aapt2 dump badging` says about the package. */
export function parseBadging(text) {
  const pkg = text.match(/^package: (.*)$/m)?.[1] ?? '';
  const field = (name) => pkg.match(new RegExp(`${name}='([^']*)'`))?.[1] ?? null;
  return {
    packageName: field('name'),
    versionName: field('versionName'),
    versionCode: field('versionCode'),
    debuggable: /^application-debuggable/m.test(text),
  };
}

/** What `apksigner verify --print-certs` says about the signature. */
export function parseSigner(text) {
  return {
    verifies: /^Verifies$/m.test(text) && !/DOES NOT VERIFY/.test(text),
    signers: Number(text.match(/^Number of signers: (\d+)/m)?.[1] ?? 0),
    dn: text.match(/^Signer #1 certificate DN: (.*)$/m)?.[1]?.trim() ?? null,
    sha256: text.match(/^Signer #1 certificate SHA-256 digest: ([0-9a-f]+)/m)?.[1] ?? null,
  };
}

/** Reasons the APK must not ship; empty when it can. */
export function releaseProblems({ badging, signer, version, expectCertSha256 }) {
  const problems = [];
  if (badging.packageName !== 'com.nigafiy.agent') problems.push(`package is ${badging.packageName ?? 'unknown'}, not com.nigafiy.agent`);
  if (badging.versionName !== version) problems.push(`versionName is ${badging.versionName ?? 'missing'}, the release is ${version} (bump Version.kt / versionName first)`);
  if (badging.debuggable) problems.push('the APK is debuggable');
  if (!signer.verifies || signer.signers < 1) problems.push('the signature does not verify');
  if (signer.dn && /CN=Android Debug/i.test(signer.dn)) problems.push('signed with the Android debug key, not the release key');
  if (expectCertSha256 && signer.sha256 !== expectCertSha256.toLowerCase()) {
    problems.push(`signed by certificate ${signer.sha256 ?? 'unknown'}, expected ${expectCertSha256.toLowerCase()}`);
  }
  return problems;
}

/** Runs a .bat through cmd.exe on Windows (fixed tool and build-output paths only). */
function bat(cmd, a, opts) {
  if (!(win && /\.(bat|cmd)$/i.test(cmd))) return spawnSync(cmd, a, opts);
  const line = [cmd, ...a].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
}

/**
 * Checks the built release APK with the SDK tools. `expectCertSha256` (optional) pins the signing
 * certificate. Returns {apk, badging, signer, problems}.
 */
export function checkReleaseApk({ version, sdk = process.env.ANDROID_HOME || 'D:\\nigafiy-tools\\android-sdk', apk = RELEASE_APK, expectCertSha256 } = {}) {
  if (!existsSync(apk)) {
    const why = existsSync(UNSIGNED_APK)
      ? 'only an unsigned release APK was built: the release key is missing (pnpm android:keystore, or copy keystore.properties + release.jks into .data/android)'
      : `no release APK at ${apk}`;
    return { apk, badging: null, signer: null, problems: [why] };
  }
  const bt = join(sdk, 'build-tools', '36.0.0');
  const javaHome = process.env.JAVA_HOME || 'D:\\nigafiy-tools\\jdk17';
  const env = { ...process.env, JAVA_HOME: javaHome, PATH: `${join(javaHome, 'bin')}${win ? ';' : ':'}${process.env.PATH}` };
  const aapt = spawnSync(join(bt, win ? 'aapt2.exe' : 'aapt2'), ['dump', 'badging', apk], { encoding: 'utf8' });
  if (aapt.status !== 0) return { apk, badging: null, signer: null, problems: [`aapt2 failed: ${aapt.stderr || aapt.error?.message}`] };
  const sig = bat(join(bt, win ? 'apksigner.bat' : 'apksigner'), ['verify', '--verbose', '--print-certs', apk], { env, encoding: 'utf8' });
  const badging = parseBadging(aapt.stdout);
  const signer = parseSigner(`${sig.stdout ?? ''}${sig.stderr ?? ''}`);
  return { apk, badging, signer, problems: releaseProblems({ badging, signer, version, expectCertSha256 }) };
}
