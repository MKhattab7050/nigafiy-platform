'use client';

import clsx from 'clsx';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { NetworkScope, ScopeSuggestion, ScopeSuggestions } from '@lan-detective/shared-types';
import { Badge, Button, ConfidenceBadge, ErrorNote, InferredBadge, Notice } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { type Query, useQuery } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';

/** Networks the site's collectors report that no authorized scope covers yet (GET /sites/:id/scope-suggestions). */
export function useScopeSuggestions(siteId: string | null): Query<ScopeSuggestions> {
  return useQuery<ScopeSuggestions>(siteId ? `/sites/${siteId}/scope-suggestions` : null, ['collectors'], 60_000);
}

/**
 * Detected ranges, each with where it came from and how sure LAN Detective is. The only action is
 * the explicit one: tick the ownership attestation (never pre-ticked) and press Authorize, which
 * calls the same POST /sites/:id/scopes as the manual form. Nothing is ever authorized automatically.
 */
export function ScopeSuggestionList({
  siteId,
  items,
  admin,
  onAuthorized,
  limit,
}: {
  siteId: string;
  items: ScopeSuggestion[];
  admin: boolean;
  onAuthorized: () => void;
  /** Show at most this many (dashboard); the rest are reachable on the Discovery page. */
  limit?: number;
}) {
  const { t } = useI18n();
  const [done, setDone] = useState('');
  const shown = limit ? items.slice(0, limit) : items;
  if (items.length === 0) return done ? <Notice>{fill(t('discovery.sugg.authorized'), { cidr: done })}</Notice> : null;
  return (
    <div className="space-y-2">
      {done && <Notice>{fill(t('discovery.sugg.authorized'), { cidr: done })}</Notice>}
      <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
        {shown.map((s) => (
          <SuggestionRow
            key={s.cidr}
            siteId={siteId}
            suggestion={s}
            admin={admin}
            onAuthorized={() => {
              setDone(s.cidr);
              onAuthorized();
            }}
          />
        ))}
      </ul>
      {!admin && <p className="text-xs text-muted">{t('discovery.sugg.adminOnly')}</p>}
      {limit && items.length > limit && (
        <Link href="/radar/discovery" className="text-xs font-medium text-accent-hover hover:underline">
          {fill(t('discovery.sugg.more'), { count: items.length - limit })}
        </Link>
      )}
    </div>
  );
}

function SuggestionRow({ siteId, suggestion: s, admin, onAuthorized }: { siteId: string; suggestion: ScopeSuggestion; admin: boolean; onAuthorized: () => void }) {
  const { t } = useI18n();
  const [attested, setAttested] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const checkboxId = `attest-${siteId}-${s.cidr.replace(/[./]/g, '-')}`;

  async function authorize() {
    setBusy(true);
    setError(null);
    try {
      await api<NetworkScope>(`/sites/${siteId}/scopes`, { method: 'POST', body: { cidr: s.cidr, authorization_confirmed: true } });
      onAuthorized();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="mono text-[13px] font-medium" dir="ltr">
          {s.cidr}
        </span>
        {s.inferred ? (
          <InferredBadge confidence={s.confidence} />
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Badge tone="ok" dot={false}>
              {t('discovery.sugg.reported')}
            </Badge>
            <ConfidenceBadge confidence={s.confidence} />
          </span>
        )}
        {s.narrowed && s.reported_cidr && (
          <span className="text-xs text-muted" title={t('discovery.sugg.narrowedWhy')}>
            {fill(t('discovery.sugg.narrowed'), { reported: s.reported_cidr })}
          </span>
        )}
      </div>
      <ul className="space-y-0.5 text-xs text-muted">
        {s.sources.map((src, i) => (
          <li key={`${src.collector_id}-${src.interface ?? 'gw'}-${i}`} dir="auto">
            {src.kind === 'interface'
              ? fill(t('discovery.sugg.fromInterface'), { collector: src.collector_name, iface: src.interface ?? '—', address: src.reported })
              : fill(t('discovery.sugg.fromGateway'), { collector: src.collector_name, address: src.reported })}
          </li>
        ))}
      </ul>
      {s.evidence.length > 0 && (
        <div>
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex h-7 items-center gap-1 rounded px-1 text-xs text-faint hover:text-fg">
            {t('common.why')}
            <ChevronDown className={clsx('size-3.5 transition-transform duration-150', open && 'rotate-180')} aria-hidden />
          </button>
          {open && (
            <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs text-muted" dir="auto">
              {s.narrowed && <li>{t('discovery.sugg.narrowedWhy')}</li>}
              {s.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {admin && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-2">
          <label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-xs text-muted">
            <input id={checkboxId} type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]" />
            <span>{t('discovery.attest')}</span>
          </label>
          <Button size="sm" variant="primary" busy={busy} disabled={!attested} onClick={() => void authorize()}>
            <ShieldCheck className="size-3.5" aria-hidden />
            {t('discovery.sugg.authorize')} <span className="mono" dir="ltr">{s.cidr}</span>
          </Button>
        </div>
      )}
      {error && <ErrorNote error={error} />}
    </li>
  );
}
