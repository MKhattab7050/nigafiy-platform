'use client';

import Link from 'next/link';
import type { ImpactPathStep, ImpactResult } from '@lan-detective/shared-types';
import { Badge, ConfidenceBadge, SectionLabel, type Tone } from '@/components/ui';
import { Metric } from '@/components/widget';
import { type Key, useI18n } from '@/lib/i18n';
import { DeviceLink } from '@/components/device-link';

const STATUS_TONE: Record<string, Tone> = {
  failed: 'crit',
  cut_off: 'crit',
  down: 'crit',
  unreachable: 'crit',
  internet_lost: 'warn',
  may_go_down: 'warn',
  attachment_unknown: 'idle',
};

function ImpactStatus({ status }: { status: string }) {
  const { t } = useI18n();
  return <Badge tone={STATUS_TONE[status] ?? 'idle'}>{t(`imp.status.${status}` as Key)}</Badge>;
}

/** The dependency path behind a conclusion, each step with whether it was observed or inferred. */
function PathView({ path }: { path: ImpactPathStep[] }) {
  const { t } = useI18n();
  if (!path.length) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted">{t('imp.result.path')}</summary>
      <ol className="mt-1 space-y-1 border-s border-line ps-3">
        {path.map((s) => (
          <li key={s.edge_id} className="text-muted">
            <span className="text-fg" dir="auto">
              {s.from_label}
            </span>{' '}
            →{' '}
            <span className="text-fg" dir="auto">
              {s.to_label}
            </span>{' '}
            <span className="text-faint">
              · {t(`imp.basis.${s.basis}` as Key)} · {t(`dx.confidence.${s.confidence}` as Key)}
              {s.uncertain && ` · ${t('imp.result.uncertainStep')}`}
            </span>
            <span className="block text-faint" dir="auto">
              {s.evidence} ({s.evidence_source})
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function ImpactResultView({ result, hideFailed }: { result: ImpactResult; hideFailed?: boolean }) {
  const { t } = useI18n();
  const s = result.summary;
  const devices = hideFailed ? result.devices.filter((d) => d.status !== 'failed') : result.devices;
  const nothing = devices.length === 0 && result.checks.length === 0 && result.endpoints.length === 0 && result.sites.every((x) => !x.dark);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {!hideFailed && <Metric label={t('imp.sum.failed')} value={s.devices_failed} tone={s.devices_failed ? 'crit' : 'idle'} />}
        <Metric label={t('imp.sum.cutOff')} value={s.devices_cut_off} tone={s.devices_cut_off ? 'crit' : 'idle'} />
        <Metric label={t('imp.sum.internetLost')} value={s.devices_internet_lost} tone={s.devices_internet_lost ? 'warn' : 'idle'} />
        <Metric label={t('imp.sum.unknown')} value={s.devices_attachment_unknown + s.endpoints_attachment_unknown} />
        <Metric label={t('imp.sum.checksDown')} value={`${s.checks_down}${s.checks_may_go_down ? ` (+${s.checks_may_go_down})` : ''}`} tone={s.checks_down ? 'crit' : 'idle'} />
        <Metric label={t('imp.sum.endpoints')} value={s.endpoints_unreachable} tone={s.endpoints_unreachable ? 'crit' : 'idle'} />
      </div>
      {nothing && <p className="text-[13px] text-muted">{t('imp.result.noImpact')}</p>}

      {result.sites.some((x) => x.dark || x.internet !== 'kept' || x.monitoring === 'blind') && (
        <div>
          <SectionLabel>{t('imp.result.sites')}</SectionLabel>
          <ul className="space-y-1.5">
            {result.sites.map((x) => (
              <li key={x.site_id} className="text-[13px]">
                <span className="flex flex-wrap items-center gap-2">
                  <span dir="auto">{x.name}</span>
                  {x.dark && <Badge tone="crit">{t('imp.site.dark')}</Badge>}
                  <Badge tone={x.internet === 'lost' ? 'crit' : x.internet === 'unknown' ? 'idle' : 'ok'}>{t(`imp.site.internet.${x.internet}` as Key)}</Badge>
                  <Badge tone={x.monitoring === 'blind' ? 'warn' : 'idle'}>{t(`imp.site.monitoring.${x.monitoring}` as Key)}</Badge>
                </span>
                {x.reasons.map((r, i) => (
                  <span key={i} className="block text-xs text-muted" dir="auto">
                    {r}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {devices.length > 0 && (
        <div>
          <SectionLabel>
            {t('imp.result.devices')} ({devices.length})
          </SectionLabel>
          <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
            {devices.map((d) => (
              <li key={d.node_id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  {d.device_id ? (
                    <DeviceLink id={d.device_id} className="font-medium text-accent-hover hover:underline" dir="auto">
                      {d.label}
                    </DeviceLink>
                  ) : (
                    <span className="font-medium" dir="auto">
                      {d.label}
                    </span>
                  )}
                  {d.ip && <span className="mono text-xs text-muted">{d.ip}</span>}
                  <ImpactStatus status={d.status} />
                  {d.is_critical && <Badge tone="warn">{t('imp.result.critical')}</Badge>}
                  <ConfidenceBadge confidence={d.confidence} />
                </div>
                <p className="mt-0.5 text-xs text-muted" dir="auto">
                  {d.reason}
                </p>
                <PathView path={d.path} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.checks.length > 0 && (
        <div>
          <SectionLabel>
            {t('imp.result.checks')} ({result.checks.length})
          </SectionLabel>
          <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
            {result.checks.map((c) => (
              <li key={c.check_id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span className="font-medium" dir="auto">
                    {c.name}
                  </span>
                  <span className="mono text-xs text-muted">{c.target}</span>
                  <ImpactStatus status={c.status} />
                  <ConfidenceBadge confidence={c.confidence} />
                </div>
                <p className="mt-0.5 text-xs text-muted" dir="auto">
                  {c.reason}
                  {c.target_binding && <span className="text-faint"> · {c.target_binding}</span>}
                </p>
                <PathView path={c.path} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.endpoints.length > 0 && (
        <div>
          <SectionLabel>
            {t('imp.result.endpoints')} ({result.endpoints.length})
          </SectionLabel>
          <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
            {result.endpoints.map((e) => (
              <li key={e.endpoint_id} className="px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Link href={`/fleet/endpoints/${e.endpoint_id}`} className="font-medium text-accent-hover hover:underline" dir="auto">
                    {e.name}
                  </Link>
                  <ImpactStatus status={e.status} />
                  <ConfidenceBadge confidence={e.confidence} />
                </div>
                <p className="mt-0.5 text-xs text-muted" dir="auto">
                  {e.reason}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.collectors.length > 0 && (
        <div>
          <SectionLabel>
            {t('imp.result.collectors')} ({result.collectors.length})
          </SectionLabel>
          <ul className="space-y-1">
            {result.collectors.map((c) => (
              <li key={c.collector_id} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span dir="auto">{c.name}</span>
                <ImpactStatus status={c.status} />
                <span className="text-xs text-muted" dir="auto">
                  {c.reason}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.limitations.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{t('imp.result.limitations')}</summary>
          <ul className="mt-1 list-disc space-y-0.5 ps-5">
            {result.limitations.map((l, i) => (
              <li key={i} dir="auto">
                {l}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
