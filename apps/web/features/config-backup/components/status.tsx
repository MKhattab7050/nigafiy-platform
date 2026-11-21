'use client';

import { Badge, ConfidenceBadge, type Tone } from '@/components/ui';
import { type Key, useI18n } from '@/lib/i18n';
import type { Target } from '../types';

/** One badge for where a backup target stands: running, not ready (and why), or the last result. */
export function TargetStatusBadge({ target }: { target: Target }) {
  const { t } = useI18n();
  if (target.pending_run_id) return <Badge tone="info">{t('cb.status.pending')}</Badge>;
  if (target.readiness !== 'ready') {
    const tone: Tone = target.readiness === 'host_key_changed' || target.readiness === 'credentials_rejected' ? 'crit' : target.readiness === 'disabled' ? 'idle' : 'warn';
    return <Badge tone={tone}>{t(`cb.ready.${target.readiness}` as Key)}</Badge>;
  }
  const tone: Tone = target.last_status === 'ok' ? 'ok' : target.last_status === 'failed' ? 'crit' : 'idle';
  return <Badge tone={tone}>{t(`cb.status.${target.last_status}` as Key)}</Badge>;
}

const CONF = ['high', 'medium', 'low'] as const;

/** The vendor in use and how it is known: set by an administrator, or detected by the collector (with confidence). */
export function VendorLabel({ target }: { target: Target }) {
  const { t } = useI18n();
  const v = target.vendor;
  if (!v) return <span className="text-xs text-muted">{t('cb.vendor.unknown')}</span>;
  const conf = CONF.find((c) => c === v.confidence) ?? null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{v.name ?? v.driver}</span>
      <Badge tone={v.source === 'manual' ? 'idle' : 'info'} dot={false}>
        {v.source === 'manual' ? t('cb.vendor.manual') : t('cb.vendor.observed')}
      </Badge>
      {v.source === 'observed' && conf && <ConfidenceBadge confidence={conf} />}
    </span>
  );
}
