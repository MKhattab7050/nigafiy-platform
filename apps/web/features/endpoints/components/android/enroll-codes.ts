import type { AndroidProvisioningInfo } from '@nigafiy/shared-types';

// The two Android enrollment codes Fleet shows (docs/features/android.md §3). Pure, tested by
// enroll-codes.test.ts.

export const ADB_DEVICE_OWNER = 'adb shell dpm set-device-owner com.nigafiy.agent/.admin.NigafiyAdminReceiver';

/** A certificate pin as the agent takes it: 64 lower-case hex digits, no colons. */
export const normalisePin = (pin: string | null): string | null => (pin ? pin.replaceAll(':', '').toLowerCase() : null);

/** nigafiy://enroll?server=…&token=…&pin=… (agents/android-agent core/EnrollLink.kt parses it). */
export function enrollLink(server: string, token: string, pin: string | null): string {
  const p = normalisePin(pin);
  return `nigafiy://enroll?server=${encodeURIComponent(server)}&token=${encodeURIComponent(token)}${p ? `&pin=${p}` : ''}`;
}

/**
 * The Device Owner provisioning QR payload (developer.android.com/work/dpc/build-dpc, "QR code"):
 * admin component, APK download location and SHA-256 checksum (base64url), and the enrollment in
 * the admin extras bundle, which the agent reads on first start (Provisioning.kt). Null when the
 * server has no built agent APK to offer.
 */
export function provisioningPayload(info: AndroidProvisioningInfo, server: string, token: string, pin: string | null): string | null {
  if (!info.apk) return null;
  const extras: Record<string, string> = { server, token };
  const p = normalisePin(pin);
  if (p) extras.pin = p;
  return JSON.stringify({
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': info.component,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': info.apk.url,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_CHECKSUM': info.apk.checksum_b64url,
    'android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED': true,
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': extras,
  });
}

/** Android refuses plain http:// except to the phone itself (EnrollLink.kt normaliseServer). */
export function phoneRefusesServer(server: string): boolean {
  if (!server.startsWith('http://')) return false;
  try {
    return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(server).hostname);
  } catch {
    return true;
  }
}
