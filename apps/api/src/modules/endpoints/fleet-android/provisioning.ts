import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import type { AndroidProvisioningInfo } from '@nigafiy/shared-types';
import { publicServerUrl } from '../../../common/http.ts';
import { env } from '../../../config/env.ts';

// What Fleet needs to enroll a phone (docs/features/android.md §3):
//  * the app enrollment link nigafiy://enroll?server=…&token=…&pin=… (the web turns it into a QR the
//    phone's camera opens, or the values are typed into the app), and
//  * the Device Owner provisioning QR for a factory-reset phone (tap the welcome screen six times):
//    a JSON with the admin component, the agent APK's download URL and its SHA-256 (base64url), and
//    the enrollment in PROVISIONING_ADMIN_EXTRAS_BUNDLE. Source:
//    https://developer.android.com/work/dpc/build-dpc (provisioning methods, QR code) and the
//    DevicePolicyManager EXTRA_PROVISIONING_* reference.
//
// The agent APK is served from NIGAFIY_ANDROID_APK (unset: the release build in this checkout,
// pnpm build:android). Without a built APK the provisioning QR is not offered (apk: null) and the
// web says why; the app link still works for a phone that has the app installed.

export const ADMIN_COMPONENT = 'com.nigafiy.agent/.admin.NigafiyAdminReceiver';
export const AGENT_APK_PATH = '/api/v1/agent/android/agent.apk';

export function androidApkPath(): string {
  if (env.NIGAFIY_ANDROID_APK) return env.NIGAFIY_ANDROID_APK;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../../../agents/android-agent/app/build/outputs/apk/release/app-release.apk');
}

let cached: { key: string; sha256: string; b64url: string; size: number } | null = null;

/** SHA-256 of the served agent APK (hex and base64url), recomputed when the file changes. */
export function agentApkDigest(): { sha256: string; checksum_b64url: string; size_bytes: number } | null {
  const file = androidApkPath();
  if (!existsSync(file)) return null;
  const st = statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  if (cached?.key !== key) {
    const digest = createHash('sha256').update(readFileSync(file)).digest();
    cached = { key, sha256: digest.toString('hex'), b64url: digest.toString('base64url'), size: st.size };
  }
  return { sha256: cached.sha256, checksum_b64url: cached.b64url, size_bytes: cached.size };
}

export function provisioningInfo(req: Request): AndroidProvisioningInfo {
  const server = publicServerUrl(req);
  const digest = agentApkDigest();
  return {
    component: ADMIN_COMPONENT,
    apk: digest ? { url: `${server.server_url.replace(/\/$/, '')}${AGENT_APK_PATH}`, ...digest } : null,
    server_url: server.server_url,
    server_url_source: server.server_url_source,
    tls_pin_sha256: server.tls_pin_sha256,
  };
}
