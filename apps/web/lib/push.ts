// Browser side of Web Push (UX review item 11). The service worker is public/sw.js; the server side is
// apps/api/src/modules/notifications/webpush*.ts.

export type PushSupport = 'ok' | 'dev' | 'insecure' | 'unsupported' | 'ios-install';

export const isProductionBuild = process.env.NODE_ENV === 'production';

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Whether this browser, here and now, can turn push on, and if not, why. */
export function pushSupport(): PushSupport {
  if (!isProductionBuild) return 'dev';
  if (!window.isSecureContext) return 'insecure';
  // iPhone / iPad: Push API exists only in a home-screen app (iOS 16.4+).
  if (isIos() && !isStandalone()) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'ok';
}

/** Registers the push service worker (idempotent). Only in production builds over a secure origin. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isProductionBuild || !window.isSecureContext || !('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Asks for permission (must run from a click) and subscribes with the server's VAPID public key. */
export async function subscribe(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw Object.assign(new Error('denied'), { code: 'push_denied' });
  const reg = (await registerServiceWorker()) ?? (await navigator.serviceWorker.getRegistration('/'));
  if (!reg) throw Object.assign(new Error('no service worker'), { code: 'push_unsupported' });
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    // A subscription made with another key (a reinstalled server) cannot be used; replace it.
    const key = existing.options.applicationServerKey;
    const same = key && new Uint8Array(key).join(',') === keyBytes(publicKey).join(',');
    if (same) return existing;
    await existing.unsubscribe();
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
}

/** SHA-256 hex of the endpoint, as the server stores it (to find this device's row). */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(new URL(endpoint).href));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
