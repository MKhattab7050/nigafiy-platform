'use client';

import { Lock, LogOut, MessageSquare, Power, RotateCcw } from 'lucide-react';
import { Meter, TimeSeriesChart } from '@/components/charts';
import type { EndpointDetail, EndpointSeriesPoint } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, Fact, Field, Input, Segmented, SkeletonBlock, Textarea } from '@/components/ui';
import { useApp, type Query } from '@/lib/app';
import { pct, relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { formatUptime, SendCommand, SeriesRange } from './helpers';
import { endpointsText } from '../../text';

export function OverviewTab({
  ep,
  online,
  busy,
  sendCommand,
  range,
  setRange,
  seriesQuery,
  message,
}: {
  ep: EndpointDetail;
  online: boolean;
  busy: string;
  sendCommand: SendCommand;
  range: SeriesRange;
  setRange: (r: SeriesRange) => void;
  seriesQuery: Query<{ points: EndpointSeriesPoint[] }>;
  message: { title: string; setTitle: (v: string) => void; body: string; setBody: (v: string) => void };
}) {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);
  const { can } = useApp();
  const { title: msgTitle, setTitle: setMsgTitle, body: msgBody, setBody: setMsgBody } = message;
  return (
                <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                  <div className="min-w-0 space-y-5">
                    <Card title={tx.currentLoad} description={`${tx.lastCheckIn}: ${relativeTime(ep.last_heartbeat_at, locale)}`}>
                      <div className="grid gap-5 sm:grid-cols-3">
                        <Meter label={tx.cpu} value={ep.cpu_pct} detail={ep.cpu_cores ? `${ep.cpu_cores} ${tx.cores}` : undefined} />
                        <Meter
                          label={tx.memory}
                          value={ep.ram_pct}
                          detail={ep.ram_total_mb ? `${((ep.ram_used_mb ?? 0) / 1024).toFixed(1)} / ${(ep.ram_total_mb / 1024).toFixed(1)} GB` : undefined}
                        />
                        <Meter label={tx.disk} value={ep.disk_used_pct} />
                      </div>
                    </Card>
                    <Card title={tx.hardwareTitle}>
                      <dl>
                        <Fact label={tx.hostname}>
                          <span className="mono">{ep.hostname ?? '—'}</span>
                        </Fact>
                        <Fact label={tx.platformLabel}>
                          <Badge tone="info">{tx.platforms[ep.platform] ?? ep.platform}</Badge>
                        </Fact>
                        {(ep.manufacturer || ep.model) && (
                          <Fact label={tx.manufacturerModel}>
                            {[ep.manufacturer, ep.model].filter(Boolean).join(' · ')}
                          </Fact>
                        )}
                        {ep.serial_number && (
                          <Fact label={tx.serialNumber}>
                            <span className="mono">{ep.serial_number}</span>
                          </Fact>
                        )}
                        <Fact label={tx.os}>{ep.os_version ?? ep.os ?? '—'}</Fact>
                        {ep.security?.os_build && (
                          <Fact label={tx.osBuild}>
                            <span className="mono">{ep.security.os_build}</span>
                          </Fact>
                        )}
                        <Fact label={tx.arch}>
                          <span className="mono">{ep.arch ?? '—'}</span>
                        </Fact>
                        <Fact label={tx.cpuModel}>
                          {ep.cpu_model ?? '—'} {ep.cpu_cores ? `(${ep.cpu_cores} ${tx.cores})` : ''}
                        </Fact>
                        <Fact label={tx.totalRam}>
                          {ep.ram_total_mb
                            ? `${(ep.ram_total_mb / 1024).toFixed(1)} GB (${ep.ram_used_mb ?? 0} ${tx.mbUsed} · ${pct(ep.ram_pct, 0)})`
                            : '—'}
                        </Fact>
                        <Fact label={tx.loggedInUser}>
                          {ep.logged_in_users.length > 0 ? (
                            <span className="font-medium text-fg">{ep.logged_in_users.join(', ')}</span>
                          ) : (
                            <span className="text-muted">{tx.noUser}</span>
                          )}
                        </Fact>
                        <Fact label={tx.ipMac}>
                          <span dir="ltr" className="mono">
                            {ep.primary_ip ?? '—'} {ep.primary_mac ? `· ${ep.primary_mac}` : ''}
                          </span>
                        </Fact>
                        <Fact label={tx.uptime}>{formatUptime(ep.uptime_seconds)}</Fact>
                        <Fact label={tx.lastCheckIn}>{relativeTime(ep.last_heartbeat_at, locale)}</Fact>
                        <Fact label={tx.agentVersion}>
                          <span className="mono">{ep.agent_version ?? '—'}</span>
                        </Fact>
                      </dl>
                    </Card>

                    <Card title={tx.disksTitle}>
                      {ep.disks.length === 0 ? (
                        <p className="text-[13px] text-muted">{tx.noInventoryYet}</p>
                      ) : (
                        <div className="space-y-4">
                          {ep.disks.map((d) => {
                            const freeGb = d.free_gb ?? Math.max(0, d.total_gb - d.used_gb);
                            return (
                              <Meter
                                key={d.mount}
                                warn={75}
                                crit={90}
                                value={d.used_pct}
                                ariaLabel={d.mount}
                                label={
                                  <span dir="ltr" className="mono font-medium text-fg">
                                    {d.mount} {d.filesystem ? `(${d.filesystem})` : ''}
                                  </span>
                                }
                                detail={`${freeGb.toFixed(1)} GB ${tx.free} ${d.total_gb.toFixed(1)} GB`}
                              />
                            );
                          })}
                        </div>
                      )}
                    </Card>

                    <Card
                      title={tx.historyTitle}
                      action={
                        <Segmented
                          value={range}
                          label={t('monitoring.range')}
                          onChange={setRange}
                          options={[
                            { value: '15m', label: '15m' },
                            { value: '1h', label: '1h' },
                            { value: '24h', label: '24h' },
                            { value: '7d', label: '7d' },
                          ]}
                        />
                      }
                    >
                      <Async query={seriesQuery} skeleton={<SkeletonBlock chart lines={1} />}>
                        {({ points }) =>
                          points.length === 0 ? (
                            <p className="py-6 text-center text-[13px] text-muted">{t('common.noData')}</p>
                          ) : (
                            <TimeSeriesChart
                              data={points.map((p) => ({ t: new Date(p.ts).getTime(), cpu_pct: p.cpu_pct, ram_pct: p.ram_pct, disk_used_pct: p.disk_used_pct }))}
                              from={new Date(points[0]!.ts).getTime()}
                              to={new Date(points[points.length - 1]!.ts).getTime()}
                              withDate={range === '7d'}
                              yDomain={[0, 100]}
                              height={208}
                              label={tx.historyTitle}
                              yFormat={(v) => pct(v, 0)}
                              series={[
                                { key: 'cpu_pct', label: tx.cpu, color: 'var(--color-series-1)' },
                                { key: 'ram_pct', label: tx.memory, color: 'var(--color-series-2)' },
                                { key: 'disk_used_pct', label: tx.disk, color: 'var(--color-series-3)' },
                              ]}
                            />
                          )
                        }
                      </Async>
                    </Card>
                  </div>

                  <div className="min-w-0 space-y-5">
                    <Card title={tx.powerTitle}>
                      {!can('technician') ? (
                        <p className="text-[13px] text-muted">{t('common.readOnly')}</p>
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Button
                            disabled={!online}
                            busy={busy === 'power-lock'}
                            onClick={() =>
                              window.confirm(tx.powerConfirm.lock) &&
                              void sendCommand('power-lock', { kind: 'power_action', action: 'lock' })
                            }
                          >
                            <Lock className="size-4" aria-hidden />
                            {tx.powerActions.lock}
                          </Button>
                          <Button
                            disabled={!online}
                            busy={busy === 'power-logoff'}
                            onClick={() =>
                              window.confirm(tx.powerConfirm.logoff) &&
                              void sendCommand('power-logoff', { kind: 'power_action', action: 'logoff' })
                            }
                          >
                            <LogOut className="size-4" aria-hidden />
                            {tx.powerActions.logoff}
                          </Button>
                          {can('admin') && (
                            <>
                              <Button
                                variant="danger"
                                disabled={!online}
                                busy={busy === 'power-restart'}
                                onClick={() =>
                                  window.confirm(tx.powerConfirm.restart) &&
                                  void sendCommand('power-restart', { kind: 'power_action', action: 'restart' })
                                }
                              >
                                <RotateCcw className="size-4" aria-hidden />
                                {tx.powerActions.restart}
                              </Button>
                              <Button
                                variant="danger"
                                disabled={!online}
                                busy={busy === 'power-shutdown'}
                                onClick={() =>
                                  window.confirm(tx.powerConfirm.shutdown) &&
                                  void sendCommand('power-shutdown', { kind: 'power_action', action: 'shutdown' })
                                }
                              >
                                <Power className="size-4" aria-hidden />
                                {tx.powerActions.shutdown}
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </Card>

                    <Card title={tx.messageTitle}>
                      {!can('technician') ? (
                        <p className="text-[13px] text-muted">{t('common.readOnly')}</p>
                      ) : (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!msgBody.trim()) return;
                            void sendCommand(
                              'notify',
                              {
                                kind: 'notify_user',
                                title: msgTitle.trim() || tx.messageSubjectPlaceholder,
                                message: msgBody.trim(),
                              },
                              tx.messageQueued,
                            ).then(() => setMsgBody(''));
                          }}
                          className="space-y-3"
                        >
                          <Field label={tx.messageSubject}>
                            {(fid) => (
                              <Input
                                id={fid}
                                value={msgTitle}
                                onChange={(e) => setMsgTitle(e.target.value)}
                                placeholder={tx.messageSubjectPlaceholder}
                                maxLength={120}
                              />
                            )}
                          </Field>
                          <Field label={tx.messageBody}>
                            {(fid) => (
                              <Textarea
                                id={fid}
                                value={msgBody}
                                onChange={(e) => setMsgBody(e.target.value)}
                                placeholder={tx.messageBodyPlaceholder}
                                maxLength={600}
                                rows={3}
                                required
                              />
                            )}
                          </Field>
                          <Button
                            type="submit"
                            variant="primary"
                            disabled={!online || !msgBody.trim()}
                            busy={busy === 'notify'}
                          >
                            <MessageSquare className="size-4" aria-hidden />
                            {tx.sendMessage}
                          </Button>
                        </form>
                      )}
                    </Card>
                  </div>
                </div>
  );
}
