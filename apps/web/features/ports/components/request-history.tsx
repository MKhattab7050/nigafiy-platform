'use client';

import { Async, Badge, type Tone } from '@/components/ui';
import { qs } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { type ControlDict, controlText } from '../control-text';
import type { PortRequest, PortValues } from '../control-types';

const STATUS_TONE: Record<PortRequest['status'], Tone> = { pending: 'info', verified: 'ok', failed: 'crit', expired: 'warn' };

export function changeLabel(r: Pick<PortRequest, 'op' | 'params'>, cx: ControlDict): string {
  if (r.op === 'admin_status') return r.params.admin_up ? cx.opText.up : cx.opText.down;
  if (r.op === 'alias') return `${cx.opText.alias}: “${r.params.alias ?? ''}”`;
  return `${cx.opText.vlan} ${r.params.vlan}`;
}

function values(v: PortValues | null | undefined, op: PortRequest['op'], cx: ControlDict): string {
  if (!v) return '—';
  if (op === 'admin_status') return v.admin_up === undefined || v.admin_up === null ? '—' : v.admin_up ? cx.enabled : cx.disabled;
  if (op === 'alias') return v.alias === undefined || v.alias === null ? '—' : `“${v.alias}”`;
  return v.vlan ? `VLAN ${v.vlan}` : '—';
}

/** Port change history with the values before (read by the collector right before writing) and after (read back). */
export function RequestHistory({ targetId, deviceId, ifIndex, limit = 25 }: { targetId?: string; deviceId?: string; ifIndex?: number; limit?: number }) {
  const { locale } = useI18n();
  const cx = controlText(locale);
  const q = useQuery<{ items: PortRequest[] }>(`/port-requests${qs({ target_id: targetId, device_id: deviceId, if_index: ifIndex, limit })}`, ['devices'], 15_000);
  return (
    <Async query={q}>
      {({ items }) =>
        items.length === 0 ? (
          <p className="px-4 py-3 text-xs text-muted">{cx.historyEmpty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-start text-[13px]">
              <thead>
                <tr className="border-y border-line text-xs text-muted">
                  <th scope="col" className="px-4 py-2 text-start font-medium">{cx.when}</th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">{cx.change}</th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">{cx.before}</th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">{cx.after}</th>
                  <th scope="col" className="px-4 py-2 text-start font-medium">{cx.by}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((r) => {
                  // "Before" is what the collector read right before writing when it got that far;
                  // otherwise the value Nigafiy last read (marked as such).
                  const observedBefore = r.result?.before && Object.keys(r.result.before).length > 0;
                  return (
                    <tr key={r.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs" title={absoluteTime(r.created_at, locale)}>
                        {relativeTime(r.created_at, locale)}
                        <span className="mt-1 block">
                          <Badge tone={STATUS_TONE[r.status]}>{cx.status[r.status]}</Badge>
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="mono me-1 text-xs text-muted" dir="ltr">
                          {r.port_name}
                        </span>
                        <span dir="auto">{changeLabel(r, cx)}</span>
                        {cx.purpose[r.purpose] && (
                          <span className="ms-1">
                            <Badge tone="info" dot={false}>
                              {cx.purpose[r.purpose]}
                            </Badge>
                          </span>
                        )}
                        {r.override_reason && (
                          <span className="mt-0.5 block text-xs text-warn" dir="auto">
                            {cx.overrideShown}: {r.override_reason}
                          </span>
                        )}
                        {r.error && (
                          <span className="mt-0.5 block text-xs text-crit" dir="auto">
                            {r.error}
                          </span>
                        )}
                        {r.result?.rolled_back && <span className="block text-xs text-faint">{cx.rolledBack}</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs" dir="auto">
                        {observedBefore ? (
                          values(r.result!.before, r.op, cx)
                        ) : (
                          <>
                            {values(r.before_known, r.op, cx)} <span className="text-faint">({cx.beforeLastRead})</span>
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs" dir="auto">
                        {values(r.result?.after, r.op, cx)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted" dir="ltr">
                        {r.created_by_email ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      }
    </Async>
  );
}
