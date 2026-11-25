'use client';

import type { MonitoringCheck } from '@nigafiy/shared-types';
import { Evidence } from '@/components/ui';
import { fill, useI18n } from '@/lib/i18n';

/** The measured value of a watch check's last sample, formatted for its kind (null for ping / TCP / DNS). */
export function useWatchValue(c: MonitoringCheck): { label: string; value: string; tone: 'ok' | 'warn' | 'crit' | null } | null {
  const { t, tn } = useI18n();
  const v = c.last_value;
  if (c.kind === 'http' || c.kind === 'https') {
    return { label: t('monitoring.httpStatus'), value: v === null ? '—' : String(Math.round(v)), tone: v === null ? null : c.state === 'ok' ? 'ok' : 'crit' };
  }
  if (c.kind === 'tls_expiry') {
    if (v === null) return { label: t('monitoring.certExpires'), value: '—', tone: null };
    const days = Math.floor(Math.abs(v));
    return {
      label: t('monitoring.certExpires'),
      value: v < 0 ? fill(tn('monitoring.expiredAgo', days), { days }) : fill(tn('monitoring.daysLeft', days), { days }),
      tone: c.state === 'down' ? 'crit' : c.state === 'degraded' ? 'warn' : 'ok',
    };
  }
  if (c.kind === 'snmp_oid') {
    const unit = c.config.unit ? ` ${c.config.unit}` : '';
    const text = v === null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(Math.abs(v) < 10 ? 2 : 1)}${unit}`;
    return { label: t('monitoring.value'), value: text, tone: v === null ? null : c.state === 'down' ? 'crit' : c.state === 'degraded' ? 'warn' : 'ok' };
  }
  return null;
}

/** What the collector observed on the last sample (certificate, final URL, raw OID value…), never a response body. */
export function WatchEvidence({ check }: { check: MonitoringCheck }) {
  const { t } = useI18n();
  const d = check.last_details;
  if (!d || !Object.keys(d).length) return null;
  return (
    <details className="mb-3 rounded-[6px] border border-line bg-sunken px-2.5 py-1.5 text-xs">
      <summary className="cursor-pointer select-none text-muted">
        {t('monitoring.evidence')}
        {d.verified !== undefined && <span className="ms-2 text-faint">· {d.verified ? t('monitoring.verified.yes') : t('monitoring.verified.no')}</span>}
      </summary>
      <div className="mt-2">
        <Evidence details={d as Record<string, unknown>} />
      </div>
    </details>
  );
}
