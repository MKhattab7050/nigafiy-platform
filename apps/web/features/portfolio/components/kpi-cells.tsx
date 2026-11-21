'use client';

import type { PortfolioKpis } from '@lan-detective/shared-types';
import { Badge, type Tone } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';

const VERDICT_TONE: Record<string, Tone> = { healthy: 'ok', attention: 'warn', urgent: 'crit' };

/** A site or organization needs a look when it has critical incidents, offline collectors or down checks. */
export const needsAttention = (k: PortfolioKpis) => k.incidents.critical > 0 || k.collectors.offline > 0 || k.checks.down > 0 || k.health?.verdict === 'urgent';

function Line({ parts }: { parts: (string | null | false)[] }) {
  return <span className="block text-[11.5px] text-muted">{parts.filter(Boolean).join(' · ') || '—'}</span>;
}

/** The KPI cells of one row: same order and wording for sites and organizations. */
export function KpiCells({ k }: { k: PortfolioKpis }) {
  const { t, locale } = useI18n();
  return (
    <>
      <td className="px-3 py-2.5 align-top">
        {k.health ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={VERDICT_TONE[k.health.verdict] ?? 'idle'}>{t(`ins.verdict.${k.health.verdict}` as Key)}</Badge>
            <span className="tnum text-xs text-muted">{k.health.score}</span>
          </span>
        ) : (
          <span className="text-xs text-faint">{t('pf.healthNone')}</span>
        )}
      </td>
      <td className="px-3 py-2.5 align-top">
        <span className={`tnum block text-[13px] font-medium ${k.incidents.critical ? 'text-crit' : k.incidents.total ? 'text-warn' : ''}`}>{k.incidents.total}</span>
        <Line parts={[k.incidents.critical > 0 && fill(t('pf.critical'), { n: k.incidents.critical }), k.incidents.warning > 0 && fill(t('pf.warning'), { n: k.incidents.warning })]} />
      </td>
      <td className="px-3 py-2.5 align-top">
        <span className="tnum block text-[13px] font-medium">{k.devices.total}</span>
        <Line parts={[fill(t('pf.online'), { n: k.devices.online }), k.devices.offline > 0 && fill(t('pf.offline'), { n: k.devices.offline }), k.devices.unreviewed > 0 && fill(t('pf.unreviewed'), { n: k.devices.unreviewed })]} />
      </td>
      <td className="px-3 py-2.5 align-top">
        <span className={`tnum block text-[13px] font-medium ${k.collectors.offline ? 'text-crit' : ''}`}>
          {k.collectors.online}/{k.collectors.total}
        </span>
        <Line
          parts={[
            k.collectors.offline > 0 && fill(t('pf.offline'), { n: k.collectors.offline }),
            k.collectors.never > 0 && fill(t('pf.never'), { n: k.collectors.never }),
            k.collectors.last_heartbeat_at && fill(t('pf.lastHeartbeat'), { when: relativeTime(k.collectors.last_heartbeat_at, locale) }),
          ]}
        />
      </td>
      <td className="px-3 py-2.5 align-top">
        <span className="tnum block text-[13px] font-medium">{k.endpoints.total}</span>
        <Line
          parts={[
            k.endpoints.total > 0 && fill(t('pf.online'), { n: k.endpoints.online }),
            k.endpoints.non_compliant > 0 && fill(t('pf.nonCompliant'), { n: k.endpoints.non_compliant }),
            k.endpoints.attention > 0 && fill(t('pf.attention'), { n: k.endpoints.attention }),
          ]}
        />
      </td>
      <td className="px-3 py-2.5 align-top">
        <span className={`tnum block text-[13px] font-medium ${k.checks.down ? 'text-crit' : ''}`}>
          {k.checks.ok}/{k.checks.total}
        </span>
        <Line
          parts={[
            k.checks.down > 0 && fill(t('pf.down'), { n: k.checks.down }),
            k.checks.degraded > 0 && fill(t('pf.degraded'), { n: k.checks.degraded }),
            k.checks.last_failure && fill(t('pf.lastFailure'), { name: k.checks.last_failure.name, when: relativeTime(k.checks.last_failure.at, locale) }),
          ]}
        />
      </td>
    </>
  );
}

export function KpiHeaders() {
  const { t } = useI18n();
  return (
    <>
      <th className="px-3 py-2 text-start font-medium">{t('pf.col.health')}</th>
      <th className="px-3 py-2 text-start font-medium">{t('pf.col.incidents')}</th>
      <th className="px-3 py-2 text-start font-medium">{t('pf.col.devices')}</th>
      <th className="px-3 py-2 text-start font-medium">{t('pf.col.collectors')}</th>
      <th className="px-3 py-2 text-start font-medium">{t('pf.col.endpoints')}</th>
      <th className="px-3 py-2 text-start font-medium">{t('pf.col.checks')}</th>
    </>
  );
}
