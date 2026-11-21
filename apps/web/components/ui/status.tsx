'use client';

import clsx from 'clsx';
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Info } from 'lucide-react';
import type { CheckState, Confidence, DeviceStatus } from '@lan-detective/shared-types';
import { type Key, useI18n } from '@/lib/i18n';
import { TONE, type Tone, stateTone, statusTone } from './tones';

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={clsx('inline-block size-2 shrink-0 rounded-full', TONE[tone].dot, className)} />;
}

const TONE_ICON = { ok: CheckCircle2, warn: AlertTriangle, crit: AlertOctagon, idle: CircleDashed, info: Info } as const;

/** The shape that goes with a tone, so state never depends on colour alone. */
export function ToneIcon({ tone, className }: { tone: Tone; className?: string }) {
  const Icon = TONE_ICON[tone];
  return <Icon className={clsx('shrink-0', TONE[tone].text, className ?? 'size-4')} aria-hidden />;
}

/** State is always conveyed by text as well as colour. */
export function Badge({ tone, children, dot = true }: { tone: Tone; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={clsx('inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-[5px] border px-1.5 text-[11.5px] font-medium leading-none', TONE[tone].soft)}>
      {dot && <Dot tone={tone} className="size-1.5" />}
      {children}
    </span>
  );
}

/** Plain metadata label (site name, tag). Neutral on purpose: it carries no state. */
export function Tag({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex h-5 items-center rounded-[4px] border border-line bg-raised px-1.5 text-[11px] leading-none text-muted">{children}</span>;
}

export function StatusBadge({ status }: { status: DeviceStatus }) {
  const { t } = useI18n();
  return <Badge tone={statusTone(status)}>{t(`status.${status}` as Key)}</Badge>;
}

export function StateBadge({ state }: { state: CheckState | null }) {
  const { t } = useI18n();
  return <Badge tone={stateTone(state)}>{t(`state.${state ?? 'unknown'}` as Key)}</Badge>;
}

const CONFIDENCE_TONE: Record<Confidence, Tone> = { high: 'ok', medium: 'warn', low: 'idle' };

/** How sure a conclusion is (diagnosis, device type, topology link). */
export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const { t } = useI18n();
  return (
    <Badge tone={CONFIDENCE_TONE[confidence]} dot={false}>
      <span className="flex items-end gap-px" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className={clsx('w-[3px] rounded-[1px]', i === 0 ? 'h-1.5' : i === 1 ? 'h-2' : 'h-2.5', i <= ['low', 'medium', 'high'].indexOf(confidence) ? 'bg-current' : 'bg-current/25')} />
        ))}
      </span>
      {t('dx.confidence')}: {t(`dx.confidence.${confidence}`)}
    </Badge>
  );
}

/** Something LAN Detective worked out itself: always labelled as inferred, with how sure it is. */
export function InferredBadge({ confidence }: { confidence: Confidence | null }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone="info" dot={false}>
        {t('common.inferred')}
      </Badge>
      {confidence && <ConfidenceBadge confidence={confidence} />}
    </span>
  );
}

/** A value LAN Detective filled in for the user (a default or a suggestion); the field stays editable. */
export function SuggestedBadge({ children }: { children: React.ReactNode }) {
  return (
    <Badge tone="idle" dot={false}>
      {children}
    </Badge>
  );
}
