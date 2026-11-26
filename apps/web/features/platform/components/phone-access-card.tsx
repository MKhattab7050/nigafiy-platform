'use client';

import { Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { QrCode } from '@/features/endpoints/components/android/qr-code';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';

/** A phone or tablet already is the phone: no point showing it a QR code. */
function useOnPhone(): boolean {
  const [phone, setPhone] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px), (hover: none) and (pointer: coarse)');
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

/**
 * "Open Nigafiy on your phone": a QR code for this computer's LAN address (GET /platform/phone-access,
 * which lists only addresses where the web app really answers). Hidden on phones, and when the web
 * app is reachable from this computer only — then it says how to allow the phone, if `explainOff`.
 */
export function PhoneAccessCard({ explainOff = false, className }: { explainOff?: boolean; className?: string }) {
  const { t } = useI18n();
  const phone = useOnPhone();
  const access = useQuery<{ urls: string[] }>(phone ? null : '/platform/phone-access', [], 120_000);
  const urls = access.data?.urls ?? [];
  if (phone || !access.data || (urls.length === 0 && !explainOff)) return null;
  const sameOrigin = typeof window !== 'undefined' && urls.includes(window.location.origin);
  const url = sameOrigin ? window.location.origin : urls[0];
  return (
    <section aria-label={t('phone.title')} className={className}>
      <div className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:flex-row sm:items-center sm:p-5">
        {url ? <QrCode value={url} label={t('phone.qrLabel')} size={148} /> : null}
        <div className="min-w-0 flex-1 text-[13px]">
          <p className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <Smartphone className="size-4 shrink-0" aria-hidden />
            {t('phone.title')}
          </p>
          {url ? (
            <>
              <p className="mt-1 text-muted">{t('phone.body')}</p>
              <p className="mono mt-2 text-xs text-fg" dir="ltr">
                {url}
              </p>
              <p className="mt-2 text-xs text-faint">{t('phone.sameWifi')}</p>
            </>
          ) : (
            <p className="mt-1 text-muted">{t('phone.off')}</p>
          )}
        </div>
      </div>
    </section>
  );
}
