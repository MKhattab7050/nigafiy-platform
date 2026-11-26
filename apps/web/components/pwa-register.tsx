'use client';

import { useEffect } from 'react';
import { registerServiceWorker } from '@/lib/push';

/**
 * Registers the push service worker once per page load (production builds over HTTPS only; see
 * lib/push.ts). The worker has no fetch handler, so it never caches or alters pages or sign-in.
 */
export function PwaRegister() {
  useEffect(() => {
    void registerServiceWorker();
  }, []);
  return null;
}
