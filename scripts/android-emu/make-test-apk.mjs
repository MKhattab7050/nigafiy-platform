#!/usr/bin/env node
// Builds a tiny test APK for the emulator run of Fleet's "Install APK" / "Remove app" actions:
// package com.nigafiy.emutest, no code (android:hasCode="false"), one label, signed with the SDK's
// debug key (~/.android/debug.keystore, created by the Android build). It does nothing when opened;
// it exists only so an install and a removal can be watched on a scratch emulator.
//   node scripts/android-emu/make-test-apk.mjs [out.apk]
//   ANDROID_HOME default D:\nigafiy-tools\android-sdk, JAVA_HOME default D:\nigafiy-tools\jdk17
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const win = process.platform === 'win32';
const sdk = process.env.ANDROID_HOME || 'D:\\nigafiy-tools\\android-sdk';
const javaHome = process.env.JAVA_HOME || 'D:\\nigafiy-tools\\jdk17';
const bt = join(sdk, 'build-tools', '36.0.0');
const androidJar = join(sdk, 'platforms', 'android-36', 'android.jar');
const out = resolve(process.argv[2] || join(os.tmpdir(), 'nigafiy-emutest.apk'));
const ks = join(os.homedir(), '.android', 'debug.keystore');
if (!existsSync(ks)) throw new Error(`no debug keystore at ${ks}: run pnpm build:android once`);

const dir = mkdtempSync(join(os.tmpdir(), 'nigafiy-emutest-'));
const env = { ...process.env, JAVA_HOME: javaHome, PATH: join(javaHome, 'bin') + delimiter + process.env.PATH };
function run(cmd, args) {
  const isBat = win && cmd.endsWith('.bat');
  const r = isBat
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')}"`], { env, encoding: 'utf8', windowsVerbatimArguments: true })
    : spawnSync(cmd, args, { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stdout}${r.stderr}`);
}
try {
  writeFileSync(
    join(dir, 'AndroidManifest.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.nigafiy.emutest" android:versionCode="1" android:versionName="1.0">
  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="36" />
  <application android:label="Nigafiy emulator test" android:hasCode="false" />
</manifest>
`,
  );
  const unaligned = join(dir, 'unaligned.apk');
  const aligned = join(dir, 'aligned.apk');
  run(join(bt, win ? 'aapt2.exe' : 'aapt2'), ['link', '-o', unaligned, '-I', androidJar, '--manifest', join(dir, 'AndroidManifest.xml')]);
  run(join(bt, win ? 'zipalign.exe' : 'zipalign'), ['-f', '4', unaligned, aligned]);
  run(join(bt, win ? 'apksigner.bat' : 'apksigner'), ['sign', '--ks', ks, '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--out', out, aligned]);
  console.log(out);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
