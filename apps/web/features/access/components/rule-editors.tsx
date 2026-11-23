'use client';

import { Plus, X } from 'lucide-react';
import type { ScheduleWindow } from '@nigafiy/shared-types';
import { Button, Input } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { accessText } from '../text';

export const linesToList = (s: string) =>
  s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function CategoryPicker({ all, value, onChange, disabled }: { all: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((c) => {
        const on = value.includes(c);
        return (
          <button
            key={c}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== c) : [...value, c])}
            className={`rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-60 ${on ? 'border-crit/50 bg-crit/10 text-crit' : 'border-line-strong text-muted hover:text-fg'}`}
          >
            {tx.cat[c] ?? c}
          </button>
        );
      })}
    </div>
  );
}

export function ScheduleEditor({ value, onChange, disabled }: { value: ScheduleWindow[]; onChange: (v: ScheduleWindow[]) => void; disabled?: boolean }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const set = (i: number, w: ScheduleWindow) => onChange(value.map((x, j) => (j === i ? w : x)));
  return (
    <div className="space-y-2">
      {value.map((w, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-line p-2">
          <div className="flex flex-wrap gap-1">
            {tx.days.map((d, day) => {
              const on = w.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={disabled}
                  aria-pressed={on}
                  onClick={() => set(i, { ...w, days: on ? w.days.filter((x) => x !== day) : [...w.days, day].sort() })}
                  className={`h-7 min-w-10 rounded border px-1.5 text-[11px] ${on ? 'border-accent bg-accent/15 text-fg' : 'border-line-strong text-faint'}`}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <label className="flex items-center gap-1 text-xs text-muted">
            {tx.from}
            <Input type="time" value={w.from} disabled={disabled} onChange={(e) => set(i, { ...w, from: e.target.value })} className="!h-7 !w-28" />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted">
            {tx.to}
            <Input type="time" value={w.to} disabled={disabled} onChange={(e) => set(i, { ...w, to: e.target.value })} className="!h-7 !w-28" />
          </label>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={tx.remove}>
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      ))}
      <Button size="sm" disabled={disabled} onClick={() => onChange([...value, { days: [0, 1, 2, 3, 4], from: '22:00', to: '07:00' }])}>
        <Plus className="size-3.5" aria-hidden />
        {tx.addWindow}
      </Button>
    </div>
  );
}
