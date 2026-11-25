#!/usr/bin/env node
// The scratch Android emulator for the real runs (docs/features/android.md §11). Everything lives in
// D:\nigafiy-tools: the SDK (emulator + system-images;android-36;default;x86_64, both under
// android-sdk-license only) and the AVD folder (ANDROID_AVD_HOME=D:\nigafiy-tools\avd).
//   node scripts/android-emu/emulator.mjs create     the AVD "nigafiy-scratch" (Pixel-sized, 3 GB RAM)
//   node scripts/android-emu/emulator.mjs start      boots it with its data wiped, no window, port 5580;
//                                                    returns when Android reports boot completed
//   node scripts/android-emu/emulator.mjs prepare <apk> [api-port]
//        installs the agent APK, makes it Device Owner (works only on a fresh emulator without
//        accounts) and maps the phone's 127.0.0.1:<api-port> to this PC's (adb reverse, default 3271)
//   node scripts/android-emu/emulator.mjs stop       shuts it down (the next start wipes it again)
// It needs WHPX (Windows Hypervisor Platform) for speed: `emulator -accel-check` says whether it is
// usable. Nothing here enables Windows features or needs administrator rights.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sdk = process.env.ANDROID_HOME || 'D:\\nigafiy-tools\\android-sdk';
const avdHome = process.env.ANDROID_AVD_HOME || 'D:\\nigafiy-tools\\avd';
const serial = 'emulator-5580';
const adbExe = path.join(sdk, 'platform-tools', 'adb.exe');
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: avdHome };
const adb = (...a) => execFileSync(adbExe, ['-s', serial, ...a], { encoding: 'utf8', env }).trim();
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'create') {
  // Written by hand: avdmanager fails on this image ("Could not load devices ... devices.xml").
  const dir = path.join(avdHome, 'nigafiy-scratch.avd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(avdHome, 'nigafiy-scratch.ini'), `avd.ini.encoding=UTF-8\npath=${dir}\ntarget=android-36\n`);
  writeFileSync(
    path.join(dir, 'config.ini'),
    [
      'avd.ini.encoding=UTF-8',
      'AvdId=nigafiy-scratch',
      'avd.ini.displayname=nigafiy-scratch',
      'abi.type=x86_64',
      'hw.cpu.arch=x86_64',
      'hw.cpu.ncore=4',
      'image.sysdir.1=system-images\\android-36\\default\\x86_64\\',
      'tag.id=default',
      'target=android-36',
      'PlayStore.enabled=no',
      'hw.ramSize=3072',
      'disk.dataPartition.size=6G',
      'hw.lcd.width=1080',
      'hw.lcd.height=2400',
      'hw.lcd.density=420',
      'hw.keyboard=yes',
      'hw.gpu.enabled=yes',
      'hw.gpu.mode=swiftshader_indirect',
      'hw.camera.back=emulated',
      'hw.camera.front=none',
      'hw.audioInput=no',
      'hw.audioOutput=no',
      'fastboot.forceColdBoot=yes',
      'firstboot.saveToLocalSnapshot=no',
      '',
    ].join('\n'),
  );
  console.log(`created ${dir}`);
} else if (cmd === 'start') {
  const child = spawn(
    path.join(sdk, 'emulator', 'emulator.exe'),
    ['-avd', 'nigafiy-scratch', '-no-window', '-no-audio', '-no-snapshot', '-wipe-data', '-no-boot-anim', '-gpu', 'swiftshader_indirect', '-port', '5580', '-accel', 'on'],
    { env, detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      if (adb('shell', 'getprop', 'sys.boot_completed') === '1') {
        console.log(`booted: Android ${adb('shell', 'getprop', 'ro.build.version.release')} (${serial})`);
        process.exit(0);
      }
    } catch {
      // not up yet
    }
  }
  console.error('the emulator did not finish booting within 10 minutes');
  process.exit(1);
} else if (cmd === 'prepare') {
  const [apk, port = '3271'] = rest;
  console.log(adb('install', '-r', apk));
  // Right after boot Android may still say "there are already some accounts on the device" although
  // there are none (seen on the run); it accepts the same command a few seconds later.
  for (let i = 0; ; i++) {
    try {
      console.log(adb('shell', 'dpm', 'set-device-owner', 'com.nigafiy.agent/.admin.NigafiyAdminReceiver'));
      break;
    } catch (e) {
      if (i >= 12) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  console.log(adb('reverse', `tcp:${port}`, `tcp:${port}`));
} else if (cmd === 'stop') {
  console.log(adb('emu', 'kill'));
} else {
  console.error('usage: emulator.mjs create|start|prepare <apk> [port]|stop');
  process.exit(2);
}
