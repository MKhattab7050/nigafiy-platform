'use client';

import { Trash2 } from 'lucide-react';
import { useMemo } from 'react';
import type { EndpointDetail } from '@nigafiy/shared-types';
import { Button, Card, Input } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { endpointsText } from '../../text';

export function ProcessesTab({
  ep,
  online,
  canControl,
  search,
  setSearch,
  busy,
  onKill,
}: {
  ep: EndpointDetail;
  online: boolean;
  canControl: boolean;
  search: string;
  setSearch: (v: string) => void;
  busy: string;
  onKill: (pid: number, name: string) => void;
}) {
  const { locale } = useI18n();
  const tx = endpointsText(locale);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ep.processes;
    return ep.processes.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        String(p.pid).includes(q) ||
        (p.user && p.user.toLowerCase().includes(q)),
    );
  }, [ep.processes, search]);

  return (
    <Card
      title={tx.tabs.processes}
      action={
        <div className="w-64 max-w-full">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx.searchProcesses} />
        </div>
      }
      padded={false}
    >
      {ep.processes.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-muted">{tx.noInventoryYet}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="border-b border-line bg-raised/60 text-muted">
              <tr>
                <th className="w-24 px-4 py-2.5 text-start font-medium">{tx.colPid}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colProcess}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colUser}</th>
                <th className="w-28 px-4 py-2.5 text-end font-medium">{tx.colCpu}</th>
                <th className="w-32 px-4 py-2.5 text-end font-medium">{tx.colMem}</th>
                {canControl && <th className="w-32 px-4 py-2.5 text-end font-medium">{tx.colAction}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((p) => (
                <tr key={p.pid} className="hover:bg-raised/40">
                  <td dir="ltr" className="mono px-4 py-2 text-muted">
                    {p.pid}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 font-medium text-fg">
                    {p.name}
                  </td>
                  <td className="px-4 py-2 text-muted">{p.user ?? '—'}</td>
                  <td dir="ltr" className="mono px-4 py-2 text-end text-muted">
                    {p.cpu_pct !== undefined ? `${p.cpu_pct.toFixed(1)}%` : '—'}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 text-end text-fg">
                    {p.mem_mb.toFixed(1)} MB
                  </td>
                  {canControl && (
                    <td className="px-4 py-2 text-end">
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!online || p.pid <= 4}
                        busy={busy === `kill-${p.pid}`}
                        onClick={() => onKill(p.pid, p.name)}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        {tx.killProcess}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
