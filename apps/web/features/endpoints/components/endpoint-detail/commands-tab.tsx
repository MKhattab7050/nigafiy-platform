'use client';

import type { EndpointDetail } from '@nigafiy/shared-types';
import { Badge, Card } from '@/components/ui';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { cmdTone } from './helpers';
import { endpointsText } from '../../text';

export function CommandsTab({ ep }: { ep: EndpointDetail }) {
  const { locale } = useI18n();
  const tx = endpointsText(locale);
  return (
                <Card title={tx.tabs.commands} padded={false}>
                  {ep.commands.length === 0 ? (
                    <p className="p-6 text-center text-[13px] text-muted">{tx.noCommands}</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {ep.commands.map((c) => (
                        <li key={c.id} className="space-y-1.5 px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                              {tx.commandKind[c.kind] ?? c.kind}
                              <Badge tone={cmdTone(c.status)}>{tx.commandStatus[c.status]}</Badge>
                            </span>
                            <span className="text-xs text-muted">
                              {c.created_by_name ? `${tx.requestedBy} ${c.created_by_name} · ` : ''}
                              {relativeTime(c.created_at, locale)}
                            </span>
                          </div>
                          {Object.keys(c.payload).length > 0 && (
                            <code dir="ltr" className="mono block text-xs text-muted">
                              {JSON.stringify(c.payload)}
                            </code>
                          )}
                          {c.output && (
                            <p dir="ltr" className="mono max-h-40 overflow-auto rounded bg-raised px-2.5 py-1.5 text-xs text-ok">
                              {c.output}
                            </p>
                          )}
                          {c.error && (
                            <p dir="ltr" className="mono rounded bg-crit/10 px-2.5 py-1.5 text-xs text-crit">
                              {c.error}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
  );
}
