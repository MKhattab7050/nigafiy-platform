'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui';
import { fill, useI18n } from '@/lib/i18n';
import { MarkdownView } from '@/features/knowledge';
import type { Citation, Lookup } from '../types';

/** The answer's [[kind:id]] markers become in-app links labelled with the record's name. */
function withLinks(text: string, citations: Citation[]): string {
  const clean = (s: string) => s.replace(/[[\]()\\]/g, ' ').trim() || '…';
  let out = text;
  for (const c of citations) out = out.split(c.marker).join(`[${clean(c.label)}](${c.href})`);
  return out.replace(/\[\[page:(\/[\w\-/]*)\]\]/g, (_m, p: string) => `[${p}](${p})`).replace(/\[\[[a-z]+:[^\]]*\]\]/g, '');
}

/** "AI-generated" label: shown on every piece of assistant output, never optional. */
export function AiLabel() {
  const { t } = useI18n();
  return (
    <span title={t('ai.labelHint')} className="inline-flex">
      <Badge tone="info" dot={false}>
        <Sparkles className="size-3" aria-hidden />
        {t('ai.label')}
      </Badge>
    </span>
  );
}

export function AnswerView({
  text,
  citations,
  sources,
  lookups,
  model,
  usage,
  refused,
  truncated,
}: {
  text: string;
  citations: Citation[];
  sources?: Citation[];
  lookups: Lookup[];
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  refused?: boolean;
  truncated?: boolean;
}) {
  const { t } = useI18n();
  const used = sources ?? citations;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <AiLabel />
        {model && (
          <span className="mono text-[11px] text-faint" dir="ltr">
            {model}
          </span>
        )}
        {usage && <span className="text-[11px] text-faint">{fill(t('ai.chat.tokens'), { input: usage.input_tokens, output: usage.output_tokens })}</span>}
      </div>
      {refused ? <p className="text-[13px] text-muted">{t('ai.chat.refused')}</p> : <MarkdownView source={withLinks(text, citations)} />}
      {truncated && <p className="text-xs text-warn">{t('ai.chat.truncated')}</p>}
      <p className="text-[11px] leading-relaxed text-faint">{t('ai.labelHint')}</p>
      {(used.length > 0 || lookups.length > 0) && (
        <details className="rounded-[var(--radius-control)] border border-line px-3 py-2 text-xs">
          <summary className="cursor-pointer font-medium text-muted">
            {t('ai.chat.sources')} ({used.length}) · {t('ai.chat.lookups')} ({lookups.length})
          </summary>
          {used.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {used.map((c) => (
                <li key={c.marker}>
                  <Link href={c.href} className="inline-flex h-6 items-center rounded-[5px] border border-line bg-raised px-2 text-[11.5px] text-accent-hover hover:underline" dir="auto">
                    {c.label}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {lookups.length > 0 && (
            <ol className="mt-2 list-decimal space-y-0.5 ps-5 text-muted">
              {lookups.map((l, i) => (
                <li key={i}>
                  <span className="mono" dir="ltr">
                    {l.tool}({Object.entries(l.input)
                      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                      .join(', ')})
                  </span>{' '}
                  {l.ok ? (l.count !== null ? `· ${fill(t('ai.chat.results'), { n: l.count })}` : '') : <span className="text-crit">· {t('ai.chat.lookupFailed')}</span>}
                </li>
              ))}
            </ol>
          )}
        </details>
      )}
    </div>
  );
}
