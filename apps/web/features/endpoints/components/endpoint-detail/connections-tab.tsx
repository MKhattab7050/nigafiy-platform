'use client';

import { useMemo } from 'react';
import type { EndpointDetail } from '@lan-detective/shared-types';
import { Badge, Card, Input } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { endpointsText } from '../../text';

export function ConnectionsTab({ ep, search, setSearch }: { ep: EndpointDetail; search: string; setSearch: (v: string) => void }) {
  const { locale } = useI18n();
  const tx = endpointsText(locale);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ep.connections;
    return ep.connections.filter(
      (c) =>
        c.local_address.toLowerCase().includes(q) ||
        String(c.local_port).includes(q) ||
        (c.remote_address && c.remote_address.toLowerCase().includes(q)) ||
        (c.remote_port && String(c.remote_port).includes(q)) ||
        c.state.toLowerCase().includes(q) ||
        (c.process_name && c.process_name.toLowerCase().includes(q)),
    );
  }, [ep.connections, search]);

  return (
    <Card
      title={tx.tabs.connections}
      action={
        <div className="w-64 max-w-full">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx.searchConnections} />
        </div>
      }
      padded={false}
    >
      {ep.connections.length === 0 ? (
        <p className="p-6 text-center text-[13px] text-muted">{tx.noInventoryYet}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="border-b border-line bg-raised/60 text-muted">
              <tr>
                <th className="w-20 px-4 py-2.5 text-start font-medium">{tx.colProto}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colLocal}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colRemote}</th>
                <th className="w-32 px-4 py-2.5 text-start font-medium">{tx.colConnState}</th>
                <th className="px-4 py-2.5 text-start font-medium">{tx.colProcess}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((c, idx) => (
                <tr key={idx} className="hover:bg-raised/40">
                  <td dir="ltr" className="mono uppercase px-4 py-2 text-muted">
                    {c.proto}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 font-medium text-fg">
                    {c.local_address}:{c.local_port}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 text-muted">
                    {c.remote_address ? `${c.remote_address}:${c.remote_port ?? 0}` : '—'}
                  </td>
                  <td dir="ltr" className="mono px-4 py-2">
                    <Badge tone={c.state === 'ESTABLISHED' ? 'ok' : 'idle'}>{c.state}</Badge>
                  </td>
                  <td dir="ltr" className="mono px-4 py-2 text-fg">
                    {c.process_name ? `${c.process_name} (${c.pid ?? ''})` : c.pid ? `PID ${c.pid}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
