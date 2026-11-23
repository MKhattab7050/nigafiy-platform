'use client';

import type { ImpactFailure, SpofEntry } from '@nigafiy/shared-types';
import { Badge, Button, ConfidenceBadge } from '@/components/ui';
import { type Key, fill, useI18n } from '@/lib/i18n';

/** Single points of failure, largest blast radius first. Every count says what it is; confidence is shown. */
export function SpofList({ items, limit, onSimulate }: { items: SpofEntry[]; limit?: number; onSimulate?: (target: ImpactFailure) => void }) {
  const { t } = useI18n();
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <ul className="divide-y divide-line">
      {shown.map((s) => (
        <li key={`${s.node_id ?? ''}:${s.edge_id ?? ''}:${s.label}`} className="flex flex-wrap items-start justify-between gap-2 px-4 py-2.5">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium" dir="auto">
                {s.label}
              </span>
              <Badge tone="idle" dot={false}>
                {t(`imp.kind.${s.kind}` as Key)}
              </Badge>
              {s.site_dark && <Badge tone="crit">{t('imp.spof.siteDark')}</Badge>}
              <ConfidenceBadge confidence={s.confidence} />
            </div>
            <p className="text-xs text-muted">
              {[
                fill(t('imp.spof.devices'), { n: s.devices_impacted }),
                s.critical_devices_impacted ? fill(t('imp.spof.critical'), { n: s.critical_devices_impacted }) : null,
                s.checks_down ? fill(t('imp.spof.checks'), { n: s.checks_down }) : null,
                s.endpoints_unreachable ? fill(t('imp.spof.endpoints'), { n: s.endpoints_unreachable }) : null,
                s.attachment_unknown ? fill(t('imp.spof.unknown'), { n: s.attachment_unknown }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {s.evidence.length > 0 && (
              <p className="text-[11px] text-faint" dir="auto">
                {s.evidence.slice(0, 2).join(' · ')}
              </p>
            )}
          </div>
          {onSimulate && (
            <Button size="sm" onClick={() => onSimulate(s.target)}>
              {t('imp.simulate')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
