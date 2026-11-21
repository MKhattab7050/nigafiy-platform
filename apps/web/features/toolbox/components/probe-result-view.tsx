'use client';

import type { ToolHop, ToolOpenPort, ToolRun } from '@lan-detective/shared-types';
import { Badge, Fact, Spinner } from '@/components/ui';
import { ms, pct } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { toolboxText } from '../text';

export function ProbeResultView({ run, locale }: { run: ToolRun; locale: 'en' | 'ar' }) {
  const { t } = useI18n();
  const tx = toolboxText(locale);

  if (run.status === 'pending') {
    return <Spinner label={tx.running} />;
  }

  if (run.status === 'failed' || run.status === 'expired') {
    return (
      <div className="space-y-2">
        <p className="text-[13px] text-crit">{run.error ?? t('common.error')}</p>
        <dl>
          <Fact label={tx.measuredFrom}>{run.collector_name}</Fact>
          {run.duration_ms !== null && <Fact label={tx.duration}>{ms(run.duration_ms)}</Fact>}
        </dl>
      </div>
    );
  }

  const out = (run.output ?? {}) as Record<string, unknown>;

  if (run.tool === 'ping') {
    const replied = out.replied === true;
    return (
      <dl>
        <Fact label={t('devices.status')}>
          <Badge tone={replied ? 'ok' : 'crit'}>{replied ? tx.replied : tx.noReply}</Badge>
        </Fact>
        {typeof out.resolved === 'string' && (
          <Fact label={tx.resolvedIp}>
            <code dir="ltr" className="mono">{out.resolved}</code>
          </Fact>
        )}
        <Fact label={t('monitoring.latency')}>{ms(typeof out.latency_ms === 'number' ? out.latency_ms : null)}</Fact>
        <Fact label={t('monitoring.loss')}>{pct(typeof out.loss_pct === 'number' ? out.loss_pct : null)}</Fact>
        {typeof out.jitter_ms === 'number' && <Fact label={tx.jitter}>{ms(out.jitter_ms)}</Fact>}
        {typeof out.detail === 'string' && out.detail && <Fact label={tx.detail}>{out.detail}</Fact>}
        <Fact label={tx.measuredFrom}>{run.collector_name}</Fact>
        {run.duration_ms !== null && <Fact label={tx.duration}>{ms(run.duration_ms)}</Fact>}
      </dl>
    );
  }

  if (run.tool === 'tcp') {
    const open = out.open === true;
    return (
      <dl>
        <Fact label={t('devices.status')}>
          <Badge tone={open ? 'ok' : 'crit'}>{open ? tx.portOpen : tx.portClosed}</Badge>
        </Fact>
        <Fact label={tx.port}>
          <code dir="ltr" className="mono">{String(out.port ?? run.port ?? '')}</code>
        </Fact>
        {typeof out.connect_ms === 'number' && <Fact label={tx.connectTime}>{ms(out.connect_ms)}</Fact>}
        {typeof out.resolved === 'string' && (
          <Fact label={tx.resolvedIp}>
            <code dir="ltr" className="mono">{out.resolved}</code>
          </Fact>
        )}
        {typeof out.detail === 'string' && out.detail && <Fact label={tx.detail}>{out.detail}</Fact>}
        <Fact label={tx.measuredFrom}>{run.collector_name}</Fact>
      </dl>
    );
  }

  if (run.tool === 'ports') {
    const openPorts = Array.isArray(out.open_ports) ? (out.open_ports as ToolOpenPort[]) : [];
    return (
      <div className="space-y-4">
        <dl>
          {typeof out.resolved === 'string' && (
            <Fact label={tx.resolvedIp}>
              <code dir="ltr" className="mono">{out.resolved}</code>
            </Fact>
          )}
          <Fact label={tx.portsChecked}>{String(out.checked ?? 19)}</Fact>
          <Fact label={tx.openPorts}>
            <Badge tone={openPorts.length > 0 ? 'ok' : 'idle'}>{openPorts.length}</Badge>
          </Fact>
          <Fact label={tx.measuredFrom}>{run.collector_name}</Fact>
          {run.duration_ms !== null && <Fact label={tx.duration}>{ms(run.duration_ms)}</Fact>}
        </dl>
        {openPorts.length === 0 ? (
          <p className="text-[13px] text-muted">{tx.noOpenPorts}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-start text-xs">
              <thead className="border-b border-line bg-raised/60 text-muted">
                <tr>
                  <th className="w-24 px-3 py-2 text-start font-medium">{tx.port}</th>
                  <th className="px-3 py-2 text-start font-medium">{tx.service}</th>
                  <th className="px-3 py-2 text-start font-medium">{tx.connectTime}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {openPorts.map((p) => (
                  <tr key={p.port} className="hover:bg-raised/40">
                    <td dir="ltr" className="mono px-3 py-2 font-medium text-fg">
                      {p.port}/tcp
                    </td>
                    <td dir="ltr" className="px-3 py-2 text-fg">
                      {p.service}
                    </td>
                    <td dir="ltr" className="mono px-3 py-2 text-muted">
                      {ms(p.connect_ms ?? null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  if (run.tool === 'dns') {
    const found = out.found === true;
    const addrs = Array.isArray(out.addresses) ? (out.addresses as string[]) : [];
    return (
      <dl>
        <Fact label={tx.addresses}>
          {found && addrs.length > 0 ? (
            <div dir="ltr" className="flex flex-wrap gap-1.5">
              {addrs.map((a) => (
                <code key={a} className="mono rounded border border-line-strong bg-raised px-2 py-0.5 text-xs">
                  {a}
                </code>
              ))}
            </div>
          ) : (
            <span className="text-warn">{tx.noRecords}</span>
          )}
        </Fact>
        {typeof out.lookup_ms === 'number' && <Fact label={tx.lookupTime}>{ms(out.lookup_ms)}</Fact>}
        {typeof out.resolver === 'string' && <Fact label={tx.resolver}>{out.resolver}</Fact>}
        {typeof out.detail === 'string' && out.detail && <Fact label={tx.detail}>{out.detail}</Fact>}
        <Fact label={tx.measuredFrom}>{run.collector_name}</Fact>
      </dl>
    );
  }

  if (run.tool === 'rdns') {
    const found = out.found === true;
    const names = Array.isArray(out.names) ? (out.names as string[]) : [];
    return (
      <dl>
        <Fact label={tx.names}>
          {found && names.length > 0 ? (
            <div dir="ltr" className="flex flex-wrap gap-1.5">
              {names.map((n) => (
                <code key={n} className="mono rounded border border-line-strong bg-raised px-2 py-0.5 text-xs">
                  {n}
                </code>
              ))}
            </div>
          ) : (
            <span className="text-warn">{tx.noRecords}</span>
          )}
        </Fact>
        {typeof out.detail === 'string' && out.detail && <Fact label={tx.detail}>{out.detail}</Fact>}
        <Fact label={tx.measuredFrom}>{run.collector_name}</Fact>
      </dl>
    );
  }

  if (run.tool === 'traceroute') {
    const reached = out.reached === true;
    const hops = Array.isArray(out.hops) ? (out.hops as ToolHop[]) : [];
    return (
      <div className="space-y-4">
        <dl>
          <Fact label={t('devices.status')}>
            <Badge tone={reached ? 'ok' : 'warn'}>{reached ? tx.routeReached : tx.routePartial}</Badge>
          </Fact>
          {typeof out.resolved === 'string' && (
            <Fact label={tx.resolvedIp}>
              <code dir="ltr" className="mono">{out.resolved}</code>
            </Fact>
          )}
          {typeof out.method === 'string' && <Fact label={tx.method}>{out.method}</Fact>}
          <Fact label={tx.measuredFrom}>{run.collector_name}</Fact>
          {run.duration_ms !== null && <Fact label={tx.duration}>{ms(run.duration_ms)}</Fact>}
        </dl>

        {hops.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full text-start text-xs">
              <thead className="border-b border-line bg-raised/60 text-muted">
                <tr>
                  <th className="w-16 px-3 py-2 text-start font-medium">{tx.hop}</th>
                  <th className="px-3 py-2 text-start font-medium">{tx.hopAddress}</th>
                  <th className="px-3 py-2 text-start font-medium">{tx.hopRtt}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {hops.map((h) => (
                  <tr key={h.n} className="hover:bg-raised/40">
                    <td dir="ltr" className="mono px-3 py-2 text-muted">
                      #{h.n}
                    </td>
                    <td dir="ltr" className="mono px-3 py-2">
                      {h.address ? <span className="text-fg">{h.address}</span> : <span className="text-faint">{tx.noAnswer}</span>}
                    </td>
                    <td dir="ltr" className="mono px-3 py-2 text-muted">
                      {h.rtt_ms && h.rtt_ms.length > 0 ? h.rtt_ms.map((v) => `${v} ms`).join('  ·  ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return null;
}
