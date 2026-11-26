'use client';

import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { InsightsReport } from '@nigafiy/shared-types';
import { SetupArt } from '@/components/illustrations';
import { BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

/**
 * Discovery is not set up yet (rules.ts deduction "setup": no Sensor or no authorized range).
 * Until then every counter on the dashboard would read 0, so the dashboard shows this card instead.
 */
export function needsNetworkSetup(report: InsightsReport | null | undefined): boolean {
  return !!report?.score_breakdown.some((d) => d.code === 'setup');
}

const STEPS = ['overview.setupStep1', 'overview.setupStep2', 'overview.setupStep3'] as const;

/** The one calm card a brand-new account sees in place of the dashboard: what is missing and the way in. */
export function ConnectNetworkCard() {
  const { t } = useI18n();
  return (
    <section aria-labelledby="connect-network-title" className="rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]">
      <div className="flex flex-col gap-6 p-6 sm:p-8 md:flex-row md:items-center md:gap-10">
        <div className="flex shrink-0 justify-center text-faint md:order-last md:w-56">
          <SetupArt className="h-28 w-48" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 id="connect-network-title" className="text-[19px] font-semibold leading-snug tracking-[-0.01em] text-fg" dir="auto">
            {t('overview.setupTitle')}
          </h2>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-muted" dir="auto">
            {t('overview.setupBody')}
          </p>
          <ol className="mt-5 space-y-2.5">
            {STEPS.map((key, i) => (
              <li key={key} className="flex items-center gap-3 text-[13px] text-fg">
                <span className="tnum flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-sunken text-[11.5px] font-medium text-muted" aria-hidden>
                  {i + 1}
                </span>
                <span dir="auto">{t(key)}</span>
              </li>
            ))}
          </ol>
          <Link href="/radar/discovery" className={clsx(BUTTON_BASE, BUTTON_SIZE.md, BUTTON_VARIANT.primary, 'mt-6')}>
            {t('overview.setupCta')}
            <ArrowRight className="size-4 rtl:rotate-180" aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
