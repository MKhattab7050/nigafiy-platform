'use client';

import type { SwitchCandidate } from '@lan-detective/shared-types';
import { Button, ErrorNote, InferredBadge, Tag } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/**
 * Devices that are probably switches (GET /sites/:id/switch-candidates), each with why it is a
 * candidate. Choosing one only fills in the host; credentials are never guessed or prefilled.
 */
export function SwitchCandidates({ site, chosen, onChoose }: { site: string; chosen: string; onChoose: (c: SwitchCandidate) => void }) {
  const { t, locale } = useI18n();
  const query = useQuery<{ site_id: string; items: SwitchCandidate[] }>(`/sites/${site}/switch-candidates`, ['devices'], 120_000);
  const items = query.data?.items ?? [];
  if (query.error && !query.data) return <ErrorNote error={query.error} onRetry={query.reload} />;
  if (items.length === 0) return null;
  return (
    <section className="mb-4">
      <h3 className="text-xs font-semibold text-fg">{t('ports.cand.title')}</h3>
      <p className="mb-2 mt-0.5 text-xs text-muted">{t('ports.cand.intro')}</p>
      <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
        {items.map((c) => {
          const usable = c.in_scope && Boolean(c.ip);
          const isChosen = Boolean(c.ip) && chosen === c.ip;
          return (
            <li key={c.device_id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                  <span className="font-medium" dir="auto">
                    {c.label}
                  </span>
                  {c.ip && (
                    <span className="mono text-xs text-muted" dir="ltr">
                      {c.ip}
                    </span>
                  )}
                  <span className="text-xs text-muted">{DEVICE_TYPE_LABEL[c.device_type]?.[locale] ?? c.device_type}</span>
                  {c.type_source === 'manual' && <Tag>{t('ports.cand.manualType')}</Tag>}
                  <InferredBadge confidence={c.type_source === 'inferred' ? c.type_confidence : null} />
                </p>
                <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted" dir="auto">
                  {c.reasons.map((r, i) => (
                    <li key={`${r.kind}-${i}`}>{r.evidence}</li>
                  ))}
                </ul>
                {!c.in_scope && <p className="text-xs text-warn">{t('ports.cand.outOfScope')}</p>}
              </div>
              <Button size="sm" variant={isChosen ? 'primary' : 'secondary'} aria-pressed={isChosen} disabled={!usable} onClick={() => onChoose(c)}>
                {isChosen ? t('ports.cand.chosen') : t('ports.cand.choose')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
