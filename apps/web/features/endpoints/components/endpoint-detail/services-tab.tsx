'use client';

import { Play, RotateCcw, Square } from 'lucide-react';
import { useMemo } from 'react';
import type { EndpointDetail } from '@lan-detective/shared-types';
import { Badge, Button, Card, Input, Segmented } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { endpointsText } from '../../text';

export function ServicesTab({
  ep,
  online,
  canControl,
  search,
  setSearch,
  filter,
  setFilter,
  busy,
  onServiceAction,
}: {
  ep: EndpointDetail;
  online: boolean;
  canControl: boolean;
  search: string;
  setSearch: (v: string) => void;
  filter: 'all' | 'running' | 'stopped';
  setFilter: (v: 'all' | 'running' | 'stopped') => void;
  busy: string;
  onServiceAction: (service: string, action: 'start' | 'stop' | 'restart') => void;
}) {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ep.services.filter((s) => {
      if (filter !== 'all' && s.state !== filter) return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || s.display_name.toLowerCase().includes(q);
    });
  }, [ep.services, search, filter]);

  return (
    <Card
      title={tx.tabs.services}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={filter}
            label={tx.colState}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('common.all') },
              { value: 'running', label: tx.svcRunning },
              { value: 'stopped', label: tx.svcStopped },
            ]}
          />
          <div className="w-56 max-w-full">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx.searchServices} />
          </div>
        </div>
      }
      padded={false}
    >
      {ep.services.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-muted">{tx.noInventoryYet}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="border-b border-line bg-raised/60 text-muted">
              <tr>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colServiceName}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colDisplayName}</th>
                <th className="w-28 px-4 py-2.5 text-start font-medium">{tx.colState}</th>
                <th className="w-28 px-4 py-2.5 text-start font-medium">{tx.colStartMode}</th>
                {canControl && <th className="w-52 px-4 py-2.5 text-end font-medium">{tx.colAction}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((s) => (
                <tr key={s.name} className="hover:bg-raised/40">
                  <td dir="ltr" className="mono px-4 py-2 font-medium text-fg">
                    {s.name}
                  </td>
                  <td className="px-4 py-2 text-muted">{s.display_name}</td>
                  <td className="px-4 py-2">
                    <Badge tone={s.state === 'running' ? 'ok' : 'idle'}>
                      {s.state === 'running' ? tx.svcRunning : s.state === 'stopped' ? tx.svcStopped : tx.svcOther}
                    </Badge>
                  </td>
                  <td className="px-4 py-2 text-muted">{s.start_mode ?? '—'}</td>
                  {canControl && (
                    <td className="px-4 py-2 text-end">
                      <div className="inline-flex items-center gap-1">
                        {s.state !== 'running' && (
                          <Button
                            size="sm"
                            disabled={!online}
                            busy={busy === `svc-${s.name}-start`}
                            onClick={() => onServiceAction(s.name, 'start')}
                          >
                            <Play className="size-3" aria-hidden />
                            {tx.svcStart}
                          </Button>
                        )}
                        {s.state === 'running' && (
                          <Button
                            size="sm"
                            disabled={!online}
                            busy={busy === `svc-${s.name}-stop`}
                            onClick={() => onServiceAction(s.name, 'stop')}
                          >
                            <Square className="size-3" aria-hidden />
                            {tx.svcStop}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          disabled={!online}
                          busy={busy === `svc-${s.name}-restart`}
                          onClick={() => onServiceAction(s.name, 'restart')}
                        >
                          <RotateCcw className="size-3" aria-hidden />
                          {tx.svcRestart}
                        </Button>
                      </div>
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
