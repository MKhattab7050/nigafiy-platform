'use client';

import Link from 'next/link';
import type { Confidence, Diagnosis, EvidenceItem, Incident } from '@lan-detective/shared-types';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';
import { Badge, type Tone, severityTone } from './ui';

const CONFIDENCE_TONE: Record<Confidence, Tone> = { high: 'ok', medium: 'warn', low: 'idle' };

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const { t } = useI18n();
  return (
    <Badge tone={CONFIDENCE_TONE[confidence]} dot={false}>
      {t('dx.confidence')}: {t(`dx.confidence.${confidence}`)}
    </Badge>
  );
}

export function IncidentStatusBadge({ incident }: { incident: Pick<Incident, 'status' | 'severity'> }) {
  const { t } = useI18n();
  const tone: Tone = incident.status === 'resolved' ? 'ok' : incident.status === 'acknowledged' ? 'info' : severityTone(incident.severity);
  return <Badge tone={tone}>{t(`incident.status.${incident.status}` as Key)}</Badge>;
}

function EvidenceList({ items }: { items: EvidenceItem[] }) {
  const { t, locale } = useI18n();
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {items.map((e, i) => (
        <li key={i} className="px-3 py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-[13px] font-medium text-fg" dir="auto">
              {e.label}
            </span>
            <span className="text-[11px] text-faint">
              {t(e.basis === 'observed' ? 'dx.observed' : 'dx.derived')} · {e.source}
              {e.observed_at && (
                <>
                  {' · '}
                  <span title={absoluteTime(e.observed_at, locale)}>{relativeTime(e.observed_at, locale)}</span>
                </>
              )}
            </span>
          </div>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted" dir="auto">
            {e.value}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h3>
      {children}
    </section>
  );
}

/** Renders a Network Doctor result: conclusion first, then everything needed to verify it. */
export function DiagnosisView({ diagnosis, compact }: { diagnosis: Diagnosis; compact?: boolean }) {
  const { t, locale } = useI18n();
  const d = diagnosis;
  const list = (items: string[], ordered = false) => {
    const Tag = ordered ? 'ol' : 'ul';
    return (
      <Tag className={`space-y-1 ps-5 text-[13px] leading-relaxed text-fg ${ordered ? 'list-decimal' : 'list-disc'}`} dir="auto">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </Tag>
    );
  };
  return (
    <div className="space-y-5">
      <div>
        <p className="text-[13px] leading-relaxed text-fg" dir="auto">
          {d.summary}
        </p>
        <div className="mt-3 rounded-md border border-line-strong bg-raised px-3 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('dx.probableCause')}</p>
          <p className="mt-1 text-[13px] font-medium leading-relaxed text-fg" dir="auto">
            {d.probable_cause}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <ConfidenceBadge confidence={d.confidence} />
            <span className="text-xs leading-relaxed text-muted" dir="auto">
              {d.confidence_reason}
            </span>
          </div>
        </div>
      </div>

      {d.evidence.length > 0 && (
        <Section title={t('dx.evidence')}>
          <EvidenceList items={d.evidence} />
        </Section>
      )}
      {d.ruled_out.length > 0 && (
        <Section title={t('dx.ruledOut')}>
          <EvidenceList items={d.ruled_out} />
        </Section>
      )}
      {d.alternatives.length > 0 && <Section title={t('dx.alternatives')}>{list(d.alternatives)}</Section>}
      {!compact && d.investigation_steps.length > 0 && <Section title={t('dx.steps')}>{list(d.investigation_steps, true)}</Section>}
      {!compact && d.recommendations.length > 0 && <Section title={t('dx.recommendations')}>{list(d.recommendations)}</Section>}
      {!compact && d.related_incidents.length > 0 && (
        <Section title={t('dx.related')}>
          <p className="mb-2 text-xs text-faint">{t('dx.relatedHint')}</p>
          <ul className="divide-y divide-line rounded-md border border-line">
            {d.related_incidents.map((r) => (
              <li key={r.id} className="px-3 py-2.5">
                <Link href={`/incidents/${r.id}`} className="text-[13px] font-medium text-accent-hover hover:underline" dir="auto">
                  INC-{r.number} · {r.title}
                </Link>
                <p className="mt-0.5 text-xs text-muted" dir="auto">
                  <span title={absoluteTime(r.opened_at, locale)}>{relativeTime(r.opened_at, locale)}</span> — {r.resolution_note ?? t('dx.noNote')}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <p className="mono text-start text-[11px] text-faint">
        {t('dx.engine')}: {d.engine} / {d.rule} · {absoluteTime(d.generated_at, locale)}
      </p>
    </div>
  );
}
