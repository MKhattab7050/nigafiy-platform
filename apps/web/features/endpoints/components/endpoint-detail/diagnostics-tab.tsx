'use client';

import { FileText, Terminal } from 'lucide-react';
import type { EndpointDetail } from '@nigafiy/shared-types';
import { Button, Card, Input, Select } from '@/components/ui';
import { useApp } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { SendCommand, LogSource } from './helpers';

export function DiagnosticsTab({
  ep,
  online,
  busy,
  sendCommand,
  diag,
  logs,
}: {
  ep: EndpointDetail;
  online: boolean;
  busy: string;
  sendCommand: SendCommand;
  diag: { tool: string; setTool: (v: string) => void; target: string; setTarget: (v: string) => void; output: string; setOutput: (v: string) => void };
  logs: { source: LogSource; setSource: (v: LogSource) => void; output: string; setOutput: (v: string) => void };
}) {
  const { locale } = useI18n();
  const isAr = locale === 'ar';
  const { can } = useApp();
  const { tool: diagTool, setTool: setDiagTool, target: diagTarget, setTarget: setDiagTarget, output: diagOutput, setOutput: setDiagOutput } = diag;
  const { source: logSource, setSource: setLogSource, output: logOutput, setOutput: setLogOutput } = logs;
  return (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card title={isAr ? 'طرفية التشخيص المعتمدة (Authorized Diagnostic Terminal)' : 'Authorized Diagnostic Terminal'}>
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select aria-label={isAr ? 'أداة التشخيص' : 'Diagnostic tool'} value={diagTool} onChange={(e) => setDiagTool(e.target.value)}>
                          <option value="ipconfig">ipconfig / ifconfig / ip addr</option>
                          <option value="route">route print / ip route</option>
                          <option value="arp">arp -a</option>
                          <option value="netstat">netstat -ano</option>
                          <option value="nslookup">nslookup</option>
                          <option value="whoami">whoami / id</option>
                          <option value="systeminfo">systeminfo / uname -a</option>
                          <option value="df">df -h / Get-PSDrive</option>
                          <option value="uptime">uptime</option>
                          {ep.platform === 'windows' && <option value="gpresult">gpresult /r</option>}
                        </Select>
                        {diagTool === 'nslookup' && (
                          <Input
                            dir="ltr"
                            className="mono w-48"
                            value={diagTarget}
                            onChange={(e) => setDiagTarget(e.target.value)}
                            placeholder="example.com"
                          />
                        )}
                        <Button
                          variant="primary"
                          disabled={!online || !can('technician')}
                          busy={busy === 'diag'}
                          onClick={async () => {
                            const res = await sendCommand(
                              'diag',
                              {
                                kind: 'diagnostic_command',
                                tool: diagTool,
                                ...(diagTool === 'nslookup' && diagTarget.trim() ? { target: diagTarget.trim() } : {}),
                              },
                              undefined,
                              5000,
                            );
                            if (res?.output) setDiagOutput(res.output);
                          }}
                        >
                          <Terminal className="size-4" aria-hidden />
                          {isAr ? 'تنفيذ الفحص' : 'Run Diagnostic'}
                        </Button>
                      </div>
                      <pre
                        dir="ltr"
                        className="mono max-h-96 min-h-48 overflow-auto rounded-md border border-line bg-black/80 p-3 text-xs text-emerald-300"
                      >
                        {diagOutput || (isAr ? '// اختر أداة تشخيص واضغط تنفيذ الفحص…' : '// Select an approved diagnostic tool and click Run…')}
                      </pre>
                    </div>
                  </Card>

                  <Card title={isAr ? 'سجلات أحداث النظام البعيد (System & Event Logs)' : 'Remote System & Event Logs'}>
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          aria-label={isAr ? 'مصدر السجلات' : 'Log source'}
                          value={logSource}
                          onChange={(e) => setLogSource(e.target.value as 'system' | 'application' | 'security')}
                        >
                          <option value="system">{isAr ? 'النظام (System / Journald)' : 'System / Journald'}</option>
                          <option value="application">{isAr ? 'سجلات التطبيقات (Application)' : 'Application Logs'}</option>
                          <option value="security">{isAr ? 'سجلات الأمان والمصادقة (Security / Auth)' : 'Security / Auth Logs'}</option>
                        </Select>
                        <Button
                          variant="primary"
                          disabled={!online || !can('technician')}
                          busy={busy === 'logs'}
                          onClick={async () => {
                            const res = await sendCommand(
                              'logs',
                              { kind: 'fetch_logs', source: logSource, lines: 50 },
                              undefined,
                              5000,
                            );
                            if (res?.output) setLogOutput(res.output);
                          }}
                        >
                          <FileText className="size-4" aria-hidden />
                          {isAr ? 'جلب السجلات' : 'Fetch Logs'}
                        </Button>
                      </div>
                      <pre
                        dir="ltr"
                        className="mono max-h-96 min-h-48 overflow-auto rounded-md border border-line bg-black/80 p-3 text-xs text-sky-200"
                      >
                        {logOutput || (isAr ? '// اضغط جلب السجلات لقراءة أحدث أحداث النظام…' : '// Click Fetch Logs to retrieve recent system events…')}
                      </pre>
                    </div>
                  </Card>
                </div>
  );
}
