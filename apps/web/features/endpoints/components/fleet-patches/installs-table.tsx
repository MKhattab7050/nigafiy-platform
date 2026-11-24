'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FleetPatchInstall } from '@nigafiy/shared-types';
import { Badge, Button, DataTable, type Tone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { patchesText } from './patches-text';

const stateTone = (s: FleetPatchInstall['state']): Tone => (s === 'succeeded' ? 'ok' : s === 'partial' ? 'warn' : s === 'failed' ? 'crit' : 'idle');

/** Install history (one computer, or the fleet with the computer's name). Admins cancel queued ones. */
export function PatchInstallsTable({ installs, showComputer, canAdmin, onChanged }: { installs: FleetPatchInstall[]; showComputer: boolean; canAdmin: boolean; onChanged: () => void }) {
  const { locale } = useI18n();
  const t = patchesText(locale);
  const [error, setError] = useState<string | null>(null);
  if (installs.length === 0) return <p className="p-4 text-sm text-muted">{t.noInstalls}</p>;

  async function cancel(id: string) {
    setError(null);
    try {
      await api(`/fleet/patches/installs/${id}/cancel`, { method: 'POST', body: {} });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
    onChanged();
  }

  return (
    <>
      {error && (
        <p role="alert" className="mx-4 mt-3 rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
          {error}
        </p>
      )}
      <DataTable minWidth={760}>
        <thead>
          <tr>
            {showComputer && <th>{t.computer}</th>}
            <th>{t.queued}</th>
            <th>{t.update}</th>
            <th>{t.state}</th>
            <th>{t.reboot}</th>
            <th>{t.windowLabel}</th>
            {canAdmin && <th />}
          </tr>
        </thead>
        <tbody>
          {installs.map((i) => (
            <tr key={i.id}>
              {showComputer && (
                <td>
                  <Link href={`/fleet/endpoints/${i.endpoint_id}?tab=patches`} className="text-accent-hover hover:underline" dir="auto">
                    {i.endpoint_name}
                  </Link>
                </td>
              )}
              <td className="whitespace-nowrap text-xs">{absoluteTime(i.queued_at, locale)}</td>
              <td className="text-xs">
                <details>
                  <summary className="cursor-pointer">
                    {t.updatesCount(i.updates.length)} · {t.why[i.why]}
                  </summary>
                  <ul className="mt-1 space-y-0.5">
                    {i.updates.map((u) => {
                      const r = i.results?.find((x) => x.update_id === u.update_id);
                      return (
                        <li key={u.update_id} dir="auto">
                          {u.kb ? `${ltr(u.kb)} ` : ''}
                          {u.title}
                          {r ? ` — ${r.result}${r.hresult ? ` (${ltr(r.hresult)})` : ''}` : ''}
                        </li>
                      );
                    })}
                  </ul>
                </details>
                {i.error && (
                  <p className="mt-1 text-crit" dir="auto">
                    {i.error}
                  </p>
                )}
              </td>
              <td>
                <Badge tone={stateTone(i.state)}>{t.states[i.state]}</Badge>
              </td>
              <td className="text-xs">
                {t.rebootStates[i.reboot_state]}
                {i.reboot_policy === 'ask' && i.reboot_state !== 'none' && <div className="text-faint">{t.postponed(i.postponements, i.max_postponements)}</div>}
                {i.reboot_deadline && ['asking', 'postponed', 'scheduled'].includes(i.reboot_state) && (
                  <div className="text-faint">
                    {t.deadline}: {absoluteTime(i.reboot_deadline, locale)}
                  </div>
                )}
              </td>
              <td className="text-xs text-muted" dir="auto">
                {i.window_label ?? '—'}
              </td>
              {canAdmin && (
                <td>
                  {i.state === 'queued' && (
                    <Button size="sm" onClick={() => void cancel(i.id)}>
                      {t.cancelInstall}
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </DataTable>
    </>
  );
}
