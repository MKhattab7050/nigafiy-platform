'use client';

import { ChevronDown, ExternalLink, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { Insight, InsightAction, InsightsReport } from '@lan-detective/shared-types';
import { Badge, Button, Card, ErrorNote, type Tone, severityTone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { actionText, insightText } from '@/lib/insights-text';

const VERDICT_TONE: Record<InsightsReport['verdict'], Tone> = { healthy: 'ok', attention: 'warn', urgent: 'crit' };
const INITIAL = 4;

function Action({ action, onDone }: { action: InsightAction; onDone: () => void }) {
  const { locale } = useI18n();
  const { can } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const text = actionText(action, locale);
  const cls = 'inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 text-xs font-medium text-fg hover:bg-line';

  if (action.kind === 'link') return <Link href={action.href} className={cls}>{text.label}</Link>;
  if (action.kind === 'external')
    return (
      <a href={action.href} target="_blank" rel="noreferrer noopener" className={cls}>
        {text.label}
        <ExternalLink className="size-3" aria-hidden />
      </a>
    );
  if (!can('technician')) return null;
  return (
    <span className="inline-flex flex-col">
      <Button
        size="sm"
        variant="primary"
        busy={busy}
        onClick={async () => {
          if (text.confirm && !window.confirm(text.confirm)) return;
          setBusy(true);
          setError(null);
          try {
            await api(action.href.replace(/^\/api\/v1/, ''), { method: 'POST', body: action.body ?? {} });
            onDone();
          } catch (err) {
            setError(err as ApiError);
          } finally {
            setBusy(false);
          }
        }}
      >
        {text.label}
      </Button>
      {error && (
        <span className="mt-2">
          <ErrorNote error={error} />
        </span>
      )}
    </span>
  );
}

function InsightRow({ insight, onDone }: { insight: Insight; onDone: () => void }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const text = insightText(insight, locale);
  const tone = severityTone(insight.severity);
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${tone === 'crit' ? 'bg-crit' : tone === 'warn' ? 'bg-warn' : 'bg-accent'}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-fg" dir="auto">
            {text.title}
          </p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted" dir="auto">
            {text.detail}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {insight.actions.map((a) => (
              <Action key={a.code + a.href} action={a} onDone={onDone} />
            ))}
            {insight.evidence.length > 0 && (
              <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex h-7 items-center gap-1 px-1 text-xs text-faint hover:text-fg">
                {t('ins.evidence')}
                <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
              </button>
            )}
          </div>
          {open && (
            <ul className="mt-2 list-disc space-y-0.5 ps-5 text-xs text-muted" dir="auto">
              {insight.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

/** Smart summary: a score with its reasons, and the few things worth doing now. */
export function InsightsPanel({ report, onChanged }: { report: InsightsReport; onChanged: () => void }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const [why, setWhy] = useState(false);
  const tone = VERDICT_TONE[report.verdict];
  const ring = tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-crit';
  const shown = all ? report.insights : report.insights.slice(0, INITIAL);
  return (
    <Card
      padded={false}
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="size-4 text-accent-hover" aria-hidden />
          {t('ins.title')}
        </span>
      }
      action={<Badge tone={tone}>{t(`ins.verdict.${report.verdict}`)}</Badge>}
    >
      <div className="grid gap-0 md:grid-cols-[11rem_1fr]">
        <div className="flex flex-col items-center justify-center gap-1 border-b border-line px-4 py-5 md:border-b-0 md:border-e">
          <p className={`tnum text-4xl font-semibold leading-none ${ring}`} aria-label={`${t('ins.score')}: ${report.score}/100`}>
            {report.score}
          </p>
          <p className="text-xs text-muted">{t('ins.score')} / 100</p>
          {report.score_breakdown.length > 0 && (
            <button type="button" onClick={() => setWhy(!why)} aria-expanded={why} className="mt-1 text-[11px] text-faint underline-offset-2 hover:text-fg hover:underline">
              {t('ins.scoreWhy')}
            </button>
          )}
          {why && (
            <ul className="tnum mt-2 w-full space-y-0.5 text-[11px] text-muted">
              {report.score_breakdown.map((b) => (
                <li key={b.code} className="flex justify-between gap-2">
                  <span className="truncate">{b.reason}</span>
                  <span className="text-crit">−{b.points}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {report.insights.length === 0 ? (
          <p className="px-4 py-6 text-[13px] text-muted">{t('ins.allGood')}</p>
        ) : (
          <div>
            <ul className="divide-y divide-line">
              {shown.map((i) => (
                <InsightRow key={i.id} insight={i} onDone={onChanged} />
              ))}
            </ul>
            {report.insights.length > INITIAL && (
              <div className="border-t border-line px-4 py-2">
                <button type="button" onClick={() => setAll(!all)} className="text-xs font-medium text-accent-hover hover:underline">
                  {all ? t('ins.showLess') : `${t('ins.showMore')} (${report.insights.length - INITIAL})`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
