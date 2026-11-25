#!/usr/bin/env node
// Builds and checks the Android agent: JVM unit tests, debug APK, release APK (signed with the
// local key from keystore.mjs when present), then prints what aapt2 and apksigner say about them.
// Needs a JDK 17, the Android SDK (platforms;android-36, build-tools;36.0.0) and Gradle 9.
//   JAVA_HOME     default D:\nigafiy-tools\jdk17
//   ANDROID_HOME  default D:\nigafiy-tools\android-sdk
//   GRADLE        default D:\nigafiy-tools\gradle-9.9.2\bin\gradle(.bat), else "gradle" on PATH
// Flags: --test-only (JVM tests only, no SDK needed), --offline.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const win = process.platform === 'win32';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const project = join(root, 'agents', 'android-agent');
const args = new Set(process.argv.slice(2));
const javaHome = process.env.JAVA_HOME || 'D:\\nigafiy-tools\\jdk17';
const sdk = process.env.ANDROID_HOME || 'D:\\nigafiy-tools\\android-sdk';
const gradleDefault = join('D:\\nigafiy-tools\\gradle-9.9.2', 'bin', win ? 'gradle.bat' : 'gradle');
const gradle = process.env.GRADLE || (existsSync(gradleDefault) ? gradleDefault : 'gradle');
const testOnly = args.has('--test-only');

const env = { ...process.env, JAVA_HOME: javaHome, PATH: join(javaHome, 'bin') + delimiter + process.env.PATH };
if (!testOnly) env.ANDROID_HOME = sdk;
else delete env.ANDROID_HOME;

const tasks = testOnly ? [':core:test'] : [':core:test', ':app:assembleDebug', ':app:assembleRelease'];
const gArgs = [...tasks, '--console=plain', ...(args.has('--offline') ? ['--offline'] : [])];
console.log(`> ${gradle} ${gArgs.join(' ')}`);
const run = bat(gradle, gArgs, { cwd: project, env, stdio: 'inherit' });
if (run.status !== 0) process.exit(run.status ?? 1);

// JVM test counts, from the JUnit XML reports.
const reports = join(project, 'core', 'build', 'test-results', 'test');
let tests = 0;
let failures = 0;
for (const f of existsSync(reports) ? readdirSync(reports).filter((n) => n.endsWith('.xml')) : []) {
  const head = readFileSync(join(reports, f), 'utf8').match(/<testsuite [^>]*>/)?.[0] ?? '';
  tests += Number(head.match(/tests="(\d+)"/)?.[1] ?? 0);
  failures += Number(head.match(/failures="(\d+)"/)?.[1] ?? 0) + Number(head.match(/errors="(\d+)"/)?.[1] ?? 0);
}
console.log(`\nKotlin JVM tests: ${tests} run, ${failures} failed.`);
if (testOnly) process.exit(failures ? 1 : 0);

const bt = join(sdk, 'build-tools', '36.0.0');
const aapt2 = join(bt, win ? 'aapt2.exe' : 'aapt2');
const apksigner = join(bt, win ? 'apksigner.bat' : 'apksigner');
const out = join(project, 'app', 'build', 'outputs', 'apk');
for (const [label, apk] of [
  ['debug', join(out, 'debug', 'app-debug.apk')],
  ['release', join(out, 'release', 'app-release.apk')],
  ['release (unsigned)', join(out, 'release', 'app-release-unsigned.apk')],
]) {
  if (!existsSync(apk)) continue;
  const sha = createHash('sha256').update(readFileSync(apk)).digest('hex');
  console.log(`\n== ${label}: ${apk}\n   ${statSync(apk).size} bytes, sha256 ${sha}`);
  const badging = execFileSync(aapt2, ['dump', 'badging', apk], { encoding: 'utf8' });
  for (const line of badging.split(/\r?\n/)) if (/^(package|minSdkVersion|sdkVersion|targetSdkVersion|application-debuggable|uses-permission)/.test(line)) console.log(`   ${line}`);
  const sig = bat(apksigner, ['verify', '--verbose', '--print-certs', apk], { env, encoding: 'utf8' });
  const lines = `${sig.stdout}${sig.stderr}`.split(/\r?\n/).filter((l) => /^(Verifies|Verified using|Signer #1 certificate (DN|SHA-256)|Number of signers|DOES NOT VERIFY|ERROR)/.test(l));
  for (const l of lines) console.log(`   ${l}`);
}


/**
 * Runs a .bat/.cmd through cmd.exe on Windows. The arguments are fixed tool paths, task names and
 * build-output paths, quoted when they hold spaces; nothing comes from a user.
 */
function bat(cmd, a, opts) {
  if (!(win && /\.(bat|cmd)$/i.test(cmd))) return spawnSync(cmd, a, opts);
  const line = [cmd, ...a].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
}
