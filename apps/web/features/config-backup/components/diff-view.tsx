'use client';

import clsx from 'clsx';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT, Notice, Segmented } from '@/components/ui';
import { fill, useI18n } from '@/lib/i18n';
import type { Diff, DiffLine } from '../types';

// Configuration diffs are code: monospace and left-to-right in every language. Lines are text
// nodes (React escapes them); nothing from the configuration is ever interpreted.

const ROW = { ' ': '', '-': 'bg-crit/[0.10]', '+': 'bg-ok/[0.10]' } as const;
const SIGN = { ' ': 'text-faint', '-': 'text-crit', '+': 'text-ok' } as const;

function Num({ n }: { n?: number }) {
  return <span className="w-12 shrink-0 select-none pe-2 text-end text-faint">{n ?? ''}</span>;
}

function InlineHunk({ lines }: { lines: DiffLine[] }) {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={clsx('flex min-w-max', ROW[l.op])}>
          <Num n={l.old} />
          <Num n={l.new} />
          <span className={clsx('w-4 shrink-0 select-none', SIGN[l.op])}>{l.op}</span>
          <span className="whitespace-pre pe-3">{l.text}</span>
        </div>
      ))}
    </>
  );
}

type Pair = { left: DiffLine | null; right: DiffLine | null };

/** Pairs each run of removed lines with the run of added lines after it, row by row. */
function pairs(lines: DiffLine[]): Pair[] {
  const out: Pair[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.op === ' ') {
      out.push({ left: l, right: l });
      i++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (i < lines.length && lines[i]!.op === '-') removed.push(lines[i++]!);
    while (i < lines.length && lines[i]!.op === '+') added.push(lines[i++]!);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) out.push({ left: removed[k] ?? null, right: added[k] ?? null });
  }
  return out;
}

function Side({ line, side }: { line: DiffLine | null; side: 'old' | 'new' }) {
  if (!line) return <div className="min-h-[1.4em] bg-sunken/60" />;
  return (
    <div className={clsx('flex min-h-[1.4em]', line.op !== ' ' && ROW[line.op])}>
      <Num n={side === 'old' ? line.old : line.new} />
      <span className="whitespace-pre-wrap break-all pe-2">{line.text}</span>
    </div>
  );
}

function SideHunk({ lines }: { lines: DiffLine[] }) {
  return (
    <>
      {pairs(lines).map((p, i) => (
        <div key={i} className="grid grid-cols-2 divide-x divide-line">
          <Side line={p.left} side="old" />
          <Side line={p.right} side="new" />
        </div>
      ))}
    </>
  );
}

export function DiffView({ diff, downloadHref }: { diff: Diff; downloadHref: string }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'inline' | 'side'>('inline');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium">
          {fill(t('cb.d.title'), { from: diff.from.number, to: diff.to.number })}{' '}
          <span className="mono text-xs" dir="ltr">
            <span className="text-ok">+{diff.added}</span> <span className="text-crit">−{diff.removed}</span>
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={t('cb.d.mode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'inline', label: t('cb.d.inline') },
              { value: 'side', label: t('cb.d.side') },
            ]}
          />
          <a href={downloadHref} download className={clsx(BUTTON_BASE, BUTTON_SIZE.sm, BUTTON_VARIANT.secondary)}>
            <Download className="size-3.5" aria-hidden />
            {t('cb.d.download')}
          </a>
        </div>
      </div>
      {diff.approximate && <Notice>{t('cb.d.approximate')}</Notice>}
      {diff.truncated && <Notice>{t('cb.d.truncated')}</Notice>}
      {diff.identical ? (
        <p className="text-[13px] text-muted">{t('cb.d.identical')}</p>
      ) : (
        <div dir="ltr" className="mono max-h-[70vh] overflow-auto rounded-[var(--radius-control)] border border-line bg-sunken/40 text-start text-[12px] leading-[1.4]">
          {diff.hunks.map((h, i) => (
            <div key={i} className="border-b border-line last:border-0">
              <div className="bg-raised px-3 py-0.5 text-faint">
                @@ -{h.old_start},{h.old_lines} +{h.new_start},{h.new_lines} @@
              </div>
              {mode === 'inline' ? <InlineHunk lines={h.lines} /> : <SideHunk lines={h.lines} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
