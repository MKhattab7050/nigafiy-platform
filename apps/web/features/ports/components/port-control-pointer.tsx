'use client';

import { ArrowRight, ToggleRight } from 'lucide-react';
import { ProgramLink } from '@/features/platform';
import { fill, useI18n } from '@/lib/i18n';
import { programById } from '@/lib/programs';

/**
 * Radar, Switch ports: where the port-control settings went (Milestone 4, spec §5). Write
 * credentials, VLANs, the quarantine VLAN and the change history are Guard's `/guard/port-control`;
 * the per-port disable / enable / move buttons stay on the port rows.
 */
export function PortControlPointer({ switchId }: { switchId: string | null }) {
  const { t, locale } = useI18n();
  const name = programById('guard').name[locale];
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2.5 text-[13px] text-muted">
      <ToggleRight className="size-4 shrink-0 text-faint" aria-hidden />
      <span className="min-w-0 flex-1">{t('platform.moved.radarPorts')}</span>
      <ProgramLink
        program="guard"
        href={switchId ? `/guard/port-control?switch=${encodeURIComponent(switchId)}` : '/guard/port-control'}
        className="inline-flex items-center gap-1 text-xs font-medium text-accent-hover hover:underline"
      >
        {fill(t('platform.openIn'), { name })}
        <ArrowRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
      </ProgramLink>
    </p>
  );
}
