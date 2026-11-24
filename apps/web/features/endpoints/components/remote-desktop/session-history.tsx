'use client';

import Link from 'next/link';
import type { FleetSession } from '@nigafiy/shared-types';
import { Async, Badge, Card, DataTable, type Tone } from '@/components/ui';
import { qs } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, duration } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { PermissionChips } from '../fleet-policy/permission-chips';
import { policyText } from '../fleet-policy/policy-text';
import { bytes, rdText } from './rd-text';

const CONSENT_TONE: Record<string, Tone> = { accepted: 'ok', not_required: 'idle', pending: 'warn', denied: 'crit', timeout: 'warn', unavailable: 'crit', not_refused: 'ok' };
const APPROVAL_TONE: Record<string, Tone> = { approved: 'ok', pending: 'warn', denied: 'crit', expired: 'warn' };
const BANNER_TONE: Record<string, Tone> = { shown: 'ok', pending: 'idle', unavailable: 'crit', not_supported: 'warn' };

/** Remote support session history (fleet_sessions): one endpoint, or the whole organization. */
export function SessionHistory({ endpointId, limit = 25 }: { endpointId?: string; limit?: number }) {
  const { locale } = useI18n();
  const tx = rdText(locale);
  const px = policyText(locale);
  const query = useQuery<{ sessions: FleetSession[] }>(`/fleet/sessions${qs({ endpoint_id: endpointId, limit })}`, ['devices'], 10_000);

  return (
    <Card title={tx.historyTitle} description={endpointId ? tx.historySubtitle : undefined}>
      <Async query={query}>
        {({ sessions }) =>
          sessions.length === 0 ? (
            <p className="py-4 text-sm text-muted">{tx.noSessions}</p>
          ) : (
            <DataTable stack>
              <thead>
                <tr>
                  <th>{tx.col.started}</th>
                  {!endpointId && <th>{tx.col.endpoint}</th>}
                  <th>{tx.col.operator}</th>
                  <th>{px.profileCol}</th>
                  <th>{tx.col.consent}</th>
                  <th>{tx.col.transport}</th>
                  <th>{tx.col.end}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const relayed = s.frames_relayed > 0 ? `${ltr(s.frames_relayed)} · ${bytes(s.bytes_relayed)}` : '—';
                  const clip = s.clipboard_to_remote + s.clipboard_from_remote > 0 ? ` · ${tx.col.clipboard} ${ltr(`↑${s.clipboard_to_remote} ↓${s.clipboard_from_remote}`)}` : '';
                  return (
                    <tr key={s.id}>
                      <td data-label={tx.col.started}>
                        {absoluteTime(s.started_at, locale)}
                        <span className="block text-[11px] text-faint">
                          {`${tx.col.duration} ${ltr(duration(s.started_at, s.ended_at))}`}
                          {s.source === 'audit_backfill' ? ` · ${tx.fromAudit}` : ''}
                        </span>
                      </td>
                      {!endpointId && (
                        <td data-label={tx.col.endpoint}>
                          <Link href={`/fleet/endpoints/${s.endpoint_id}`} className="text-accent-hover hover:underline" dir="auto">
                            {s.endpoint_name ?? s.endpoint_id}
                          </Link>
                        </td>
                      )}
                      <td data-label={tx.col.operator}>
                        {s.operator_email ? ltr(s.operator_email) : '—'}
                        {s.reason && (
                          <span className="block max-w-72 text-[11px] text-muted" dir="auto">
                            {s.reason}
                          </span>
                        )}
                      </td>
                      <td data-label={px.profileCol}>
                        {s.profile_name ? (
                          <span dir="auto">
                            {s.profile_name}
                            {s.group_name && <span className="text-faint">{` · ${s.group_name}`}</span>}
                          </span>
                        ) : (
                          '—'
                        )}
                        {s.permissions && <PermissionChips permissions={s.permissions} className="mt-1 max-w-80" />}
                      </td>
                      <td data-label={tx.col.consent}>
                        <span className="flex flex-wrap gap-1">
                          {s.approval_state !== 'not_required' && (
                            <Badge tone={APPROVAL_TONE[s.approval_state] ?? 'idle'}>{`${px.approvalCol}: ${px.decision[s.approval_state] ?? s.approval_state}`}</Badge>
                          )}
                          <Badge tone={CONSENT_TONE[s.consent_result] ?? 'idle'}>{tx.consentResult[s.consent_result] ?? s.consent_result}</Badge>
                          <Badge tone={BANNER_TONE[s.banner_state] ?? 'idle'}>{`${tx.col.banner}: ${tx.bannerShort[s.banner_state] ?? s.banner_state}`}</Badge>
                        </span>
                        {s.approver_email && <span className="block text-[11px] text-faint">{`${px.approvalCol} ${px.decidedBy(ltr(s.approver_email))}`}</span>}
                      </td>
                      <td data-label={tx.col.transport}>
                        {tx.transport[s.transport] ?? s.transport}
                        <span className="block text-[11px] text-faint">{`${tx.col.relayed} ${relayed}${clip}`}</span>
                      </td>
                      <td data-label={tx.col.end}>
                        {s.state !== 'ended' ? (
                          <Badge tone={s.state === 'active' ? 'ok' : 'warn'}>{s.state === 'waiting_approval' ? px.waitingApproval : s.state === 'waiting_consent' ? tx.waitingConsent : tx.open}</Badge>
                        ) : (
                          <span>
                            {s.end_reason ? tx.endShort[s.end_reason] : '—'}
                            {s.ended_by_email && <span className="block text-[11px] text-faint">{ltr(s.ended_by_email)}</span>}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )
        }
      </Async>
    </Card>
  );
}
