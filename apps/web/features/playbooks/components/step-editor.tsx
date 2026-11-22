'use client';

import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { Badge, Button, Field, Input, Select, Textarea } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { actionLabel, conditionLabel } from '../text';
import type { ActionKey, Catalog, StepDef, Trigger } from '../types';
import { CheckList, DevicePicker, usePbText } from './common';

type Params = Record<string, unknown>;

/** Parameters of a freshly added step that the API schema accepts (text the person must still write is left empty). */
export function defaultParams(action: ActionKey): Params {
  switch (action) {
    case 'notify':
      return { channel_ids: [], severity: 'info', title: '{playbook}: {title}', message: '', attach: 'trigger' };
    case 'run_tool':
      return { tool: 'ping', target: 'trigger_device', port: null, device_id: null };
    case 'wake_device':
    case 'dns_resume':
      return { device_id: null };
    case 'set_trust':
      return { trust: 'known', device_id: null };
    case 'dns_pause':
      return { minutes: 60, device_id: null };
    case 'router_block':
    case 'router_unblock':
      return { router_id: null, device_id: null };
    case 'router_rate_limit':
      return { router_id: null, device_id: null, down_kbps: 1000, up_kbps: 1000 };
    case 'router_wifi':
      return { router_id: '', wifi_id: '', enabled: false, confirm_main_network: false };
    case 'router_reboot':
      return { router_id: '' };
    case 'switch_port_quarantine':
      return { reason: '', device_id: null };
    case 'switch_port_disable':
      return { device_id: null };
    case 'config_backup':
      return { target_id: null, device_id: null };
    case 'endpoint_command':
      return { command: { kind: 'refresh_inventory' }, endpoint_id: null, device_id: null };
    case 'incident_comment':
      return { body: '', include_previous_output: true };
    case 'wait':
      return { seconds: 60 };
    case 'condition':
      return { test: 'device_online', check_id: null, device_id: null, if_true: 'continue' };
    case 'approval':
      return { message: '' };
    default:
      return {};
  }
}

const COMMAND_DEFAULTS: Record<string, Params> = {
  refresh_inventory: { kind: 'refresh_inventory' },
  notify_user: { kind: 'notify_user', title: '', message: '' },
  service_action: { kind: 'service_action', service: '', action: 'restart' },
  power_action: { kind: 'power_action', action: 'restart' },
  fetch_logs: { kind: 'fetch_logs', source: 'system', lines: 60 },
  diagnostic_command: { kind: 'diagnostic_command', tool: 'ipconfig' },
};
const DIAG_TOOLS = ['ipconfig', 'route', 'arp', 'nslookup', 'whoami', 'systeminfo', 'netstat', 'gpresult', 'df', 'uptime'];
const SEVERITIES = ['info', 'warning', 'critical'] as const;
const SEV_LABEL = { en: { info: 'Info', warning: 'Warning', critical: 'Critical' }, ar: { info: 'معلومة', warning: 'تحذير', critical: 'حرج' } } as const;
const CHECK_STATES = ['unknown', 'ok', 'degraded', 'down'] as const;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const numOr = (v: unknown, d: number) => (typeof v === 'number' ? v : d);

/** Errors the API returned for this step (`steps.<i>.…`), keyed by the rest of the path. */
export type StepErrors = Record<string, string>;

function err(errors: StepErrors, ...paths: string[]): string | undefined {
  for (const p of paths) if (errors[p]) return errors[p];
  return undefined;
}

function ChannelPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const tx = usePbText();
  const { can } = useApp();
  const q = useQuery<{ items: { id: string; name: string; kind: string; enabled: boolean }[] }>(can('admin') ? '/notification-channels' : null, [], 0);
  if (!can('admin')) return <p className="text-xs text-muted">{tx.channelsAdminOnly}</p>;
  if (q.error) return <p className="text-xs text-crit">{q.error.message}</p>;
  if (!q.data) return null;
  if (!q.data.items.length) return <p className="text-xs text-muted">{tx.noChannels}</p>;
  return <CheckList label={tx.channels} options={q.data.items.map((c) => ({ value: c.id, label: `${c.name} (${c.kind})${c.enabled ? '' : ' ✕'}` }))} value={value} onChange={onChange} />;
}

function RouterPicker({
  value,
  onChange,
  siteId,
  error,
  required = false,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  siteId: string | null;
  error?: string;
  /** One router must be chosen (Wi-Fi networks and reboots are router-specific). */
  required?: boolean;
}) {
  const tx = usePbText();
  const { siteId: globalSite } = useApp();
  const q = useQuery<{ items: { id: string; name: string; address: string }[] }>(`/routers${qs({ site_id: siteId ?? globalSite })}`, [], 0);
  return (
    <Field label={required ? tx.routerRequired : tx.router} error={error} hint={q.data && !q.data.items.length ? tx.routersNone : undefined}>
      {(id) => (
        <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{required ? tx.chooseRouter : tx.allRouters}</option>
          {value && !q.data?.items.some((r) => r.id === value) && <option value={value}>{value}</option>}
          {(q.data?.items ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.address})
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function BackupTargetPicker({ value, onChange, siteId, error }: { value: string | null; onChange: (v: string | null) => void; siteId: string | null; error?: string }) {
  const tx = usePbText();
  const { siteId: globalSite } = useApp();
  const q = useQuery<{ items: { id: string; name: string; address: string }[] }>(`/config-backup/targets${qs({ site_id: siteId ?? globalSite })}`, [], 0);
  return (
    <Field label={tx.backupTarget} error={error}>
      {(id) => (
        <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{tx.backupTargetTrigger}</option>
          {value && !q.data?.items.some((t) => t.id === value) && <option value={value}>{value}</option>}
          {(q.data?.items ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({ltr(t.address)})
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function CheckPicker({ value, onChange, siteId, error }: { value: string | null; onChange: (v: string | null) => void; siteId: string | null; error?: string }) {
  const tx = usePbText();
  const { siteId: globalSite } = useApp();
  const q = useQuery<{ items: { id: string; name: string }[] }>(`/checks${qs({ site_id: siteId ?? globalSite })}`, [], 0);
  return (
    <Field label={tx.checkPick} error={error}>
      {(id) => (
        <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">{tx.triggerCheck}</option>
          {value && !q.data?.items.some((c) => c.id === value) && <option value={value}>{value}</option>}
          {(q.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function CommandEditor({ value, onChange, kinds, errors }: { value: Params; onChange: (v: Params) => void; kinds: string[]; errors: StepErrors }) {
  const tx = usePbText();
  const kind = str(value.kind) || 'refresh_inventory';
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  const e = (k: string) => err(errors, `params.command.${k}`, 'params.command');
  return (
    <div className="space-y-3">
      <Field label={tx.command} error={err(errors, 'params.command')}>
        {(id) => (
          <Select id={id} value={kind} onChange={(ev) => onChange({ ...(COMMAND_DEFAULTS[ev.target.value] ?? { kind: ev.target.value }) })}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {(tx.commandKind as Record<string, string>)[k] ?? k}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {kind === 'notify_user' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.userTitle} error={e('title')}>
            {(id) => <Input id={id} dir="auto" maxLength={120} value={str(value.title)} onChange={(ev) => set('title', ev.target.value)} />}
          </Field>
          <Field label={tx.userMessage} error={e('message')}>
            {(id) => <Input id={id} dir="auto" maxLength={600} value={str(value.message)} onChange={(ev) => set('message', ev.target.value)} />}
          </Field>
        </div>
      )}
      {kind === 'service_action' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.service} error={e('service')}>
            {(id) => <Input id={id} dir="ltr" className="mono" maxLength={160} value={str(value.service)} onChange={(ev) => set('service', ev.target.value)} />}
          </Field>
          <Field label={tx.serviceAction}>
            {(id) => (
              <Select id={id} value={str(value.action) || 'restart'} onChange={(ev) => set('action', ev.target.value)}>
                {(['start', 'stop', 'restart'] as const).map((a) => (
                  <option key={a} value={a}>
                    {tx.serviceActions[a]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
      {kind === 'power_action' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.powerAction}>
            {(id) => (
              <Select id={id} value={str(value.action) || 'restart'} onChange={(ev) => set('action', ev.target.value)}>
                {(['restart', 'shutdown', 'lock', 'logoff'] as const).map((a) => (
                  <option key={a} value={a}>
                    {tx.powerActions[a]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={tx.reason} error={e('reason')}>
            {(id) => <Input id={id} dir="auto" maxLength={240} value={str(value.reason)} onChange={(ev) => onChange(ev.target.value ? { ...value, reason: ev.target.value } : (({ reason: _r, ...rest }) => rest)(value))} />}
          </Field>
        </div>
      )}
      {kind === 'fetch_logs' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.logSource}>
            {(id) => (
              <Select id={id} value={str(value.source) || 'system'} onChange={(ev) => set('source', ev.target.value)}>
                {(['system', 'application', 'security'] as const).map((a) => (
                  <option key={a} value={a}>
                    {tx.logSources[a]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={tx.lines} error={e('lines')}>
            {(id) => <Input id={id} type="number" min={10} max={200} value={numOr(value.lines, 60)} onChange={(ev) => set('lines', Number(ev.target.value))} />}
          </Field>
        </div>
      )}
      {kind === 'diagnostic_command' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.diagTool}>
            {(id) => (
              <Select id={id} value={str(value.tool) || 'ipconfig'} onChange={(ev) => set('tool', ev.target.value)}>
                {DIAG_TOOLS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={tx.diagTarget} error={e('target')}>
            {(id) => (
              <Input
                id={id}
                dir="ltr"
                className="mono"
                maxLength={180}
                value={str(value.target)}
                onChange={(ev) => onChange(ev.target.value ? { ...value, target: ev.target.value } : (({ target: _t, ...rest }) => rest)(value))}
              />
            )}
          </Field>
        </div>
      )}
    </div>
  );
}

/** The parameter fields of one step, per action, matching the API schema exactly. */
function ParamsEditor({ step, onChange, catalog, trigger, siteId, errors }: { step: StepDef; onChange: (p: Params) => void; catalog: Catalog; trigger: Trigger; siteId: string | null; errors: StepErrors }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const p = step.params;
  const set = (k: string, v: unknown) => onChange({ ...p, [k]: v });
  const info = catalog.actions.find((a) => a.key === step.action);
  const scheduled = trigger.kind === 'schedule';
  const devicePicker = info?.needs_device ? (
    <div>
      <DevicePicker value={(p.device_id as string | null) ?? null} onChange={(v) => set('device_id', v)} label={tx.device} allowTrigger={!scheduled} siteId={siteId} />
      {err(errors, 'params.device_id') && <p className="mt-1 text-xs text-crit">{err(errors, 'params.device_id')}</p>}
    </div>
  ) : null;

  switch (step.action) {
    case 'notify':
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
            <Field label={tx.title} error={err(errors, 'params.title')}>
              {(id) => <Input id={id} dir="auto" maxLength={200} value={str(p.title)} onChange={(e) => set('title', e.target.value)} />}
            </Field>
            <Field label={tx.severity}>
              {(id) => (
                <Select id={id} value={str(p.severity) || 'info'} onChange={(e) => set('severity', e.target.value)}>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {SEV_LABEL[locale][s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field label={tx.message} hint={tx.placeholders} error={err(errors, 'params.message')}>
            {(id) => <Textarea id={id} dir="auto" maxLength={2000} value={str(p.message)} onChange={(e) => set('message', e.target.value)} />}
          </Field>
          <Field label={tx.attach}>
            {(id) => (
              <Select id={id} value={str(p.attach) || 'trigger'} onChange={(e) => set('attach', e.target.value)}>
                {(['none', 'trigger', 'previous_output', 'site_summary'] as const).map((a) => (
                  <option key={a} value={a}>
                    {tx.attachOpts[a]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ChannelPicker value={(p.channel_ids as string[]) ?? []} onChange={(v) => set('channel_ids', v)} />
          {err(errors, 'params.channel_ids') && <p className="text-xs text-crit">{err(errors, 'params.channel_ids')}</p>}
        </div>
      );
    case 'run_tool': {
      const target = str(p.target) || 'trigger_device';
      const tool = str(p.tool) || 'ping';
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tx.tool}>
              {(id) => (
                <Select id={id} value={tool} onChange={(e) => onChange({ ...p, tool: e.target.value, port: e.target.value === 'tcp' ? (p.port ?? 443) : null })}>
                  {catalog.tool_kinds.map((k) => (
                    <option key={k} value={k}>
                      {(tx.toolKind as Record<string, string>)[k] ?? k}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={tx.target} error={err(errors, 'params.target')}>
              {(id) => (
                <Select
                  id={id}
                  value={target}
                  onChange={(e) => {
                    const next: Params = { ...p, target: e.target.value };
                    if (e.target.value !== 'custom') delete next.custom_target;
                    else next.custom_target = '';
                    onChange(next);
                  }}
                >
                  {(['trigger_device', 'trigger_check', 'custom'] as const).map((k) => (
                    <option key={k} value={k}>
                      {tx.targetOpts[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {target === 'custom' && (
            <Field label={tx.customTarget} error={err(errors, 'params.custom_target')}>
              {(id) => <Input id={id} dir="ltr" className="mono" maxLength={253} value={str(p.custom_target)} onChange={(e) => set('custom_target', e.target.value)} />}
            </Field>
          )}
          {target === 'trigger_device' && (
            <div>
              <DevicePicker value={(p.device_id as string | null) ?? null} onChange={(v) => set('device_id', v)} label={tx.device} allowTrigger={!scheduled} siteId={siteId} />
              {err(errors, 'params.device_id') && <p className="mt-1 text-xs text-crit">{err(errors, 'params.device_id')}</p>}
            </div>
          )}
          {tool === 'tcp' && (
            <Field label={tx.port} error={err(errors, 'params.port')}>
              {(id) => <Input id={id} type="number" min={1} max={65535} value={numOr(p.port, 443)} onChange={(e) => set('port', Number(e.target.value))} />}
            </Field>
          )}
        </div>
      );
    }
    case 'set_trust':
      return (
        <div className="space-y-3">
          <Field label={tx.trust}>
            {(id) => (
              <Select id={id} value={str(p.trust) || 'known'} onChange={(e) => set('trust', e.target.value)}>
                {(['known', 'unreviewed', 'unwanted'] as const).map((k) => (
                  <option key={k} value={k}>
                    {tx.trustOpts[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {devicePicker}
        </div>
      );
    case 'dns_pause':
      return (
        <div className="space-y-3">
          <Field label={tx.minutes} error={err(errors, 'params.minutes')}>
            {(id) => <Input id={id} type="number" min={1} max={10080} value={numOr(p.minutes, 60)} onChange={(e) => set('minutes', Number(e.target.value))} />}
          </Field>
          {devicePicker}
        </div>
      );
    case 'router_block':
    case 'router_unblock':
    case 'router_rate_limit':
      return (
        <div className="space-y-3">
          <RouterPicker value={(p.router_id as string | null) ?? null} onChange={(v) => set('router_id', v)} siteId={siteId} error={err(errors, 'params.router_id')} />
          {step.action === 'router_rate_limit' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={tx.downKbps} error={err(errors, 'params.down_kbps', 'params')}>
                {(id) => <Input id={id} type="number" min={0} max={10_000_000} value={numOr(p.down_kbps, 0)} onChange={(e) => set('down_kbps', Number(e.target.value))} />}
              </Field>
              <Field label={tx.upKbps} error={err(errors, 'params.up_kbps')}>
                {(id) => <Input id={id} type="number" min={0} max={10_000_000} value={numOr(p.up_kbps, 0)} onChange={(e) => set('up_kbps', Number(e.target.value))} />}
              </Field>
            </div>
          )}
          {devicePicker}
        </div>
      );
    case 'router_wifi':
      return (
        <div className="space-y-3">
          <RouterPicker required value={(p.router_id as string | null) || null} onChange={(v) => set('router_id', v ?? '')} siteId={siteId} error={err(errors, 'params.router_id')} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tx.wifiId} error={err(errors, 'params.wifi_id')}>
              {(id) => <Input id={id} dir="ltr" className="mono" maxLength={40} value={str(p.wifi_id)} onChange={(e) => set('wifi_id', e.target.value)} />}
            </Field>
            <Field label={tx.wifiTurn}>
              {(id) => (
                <Select id={id} value={p.enabled === true ? 'on' : 'off'} onChange={(e) => set('enabled', e.target.value === 'on')}>
                  <option value="on">{tx.wifiOn}</option>
                  <option value="off">{tx.wifiOff}</option>
                </Select>
              )}
            </Field>
          </div>
          <label className="inline-flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={p.confirm_main_network === true} onChange={(e) => set('confirm_main_network', e.target.checked)} />
            {tx.confirmMainNetwork}
          </label>
        </div>
      );
    case 'router_reboot':
      return (
        <div className="space-y-3">
          <p className="text-xs text-muted">{tx.rebootHint}</p>
          <RouterPicker required value={(p.router_id as string | null) || null} onChange={(v) => set('router_id', v ?? '')} siteId={siteId} error={err(errors, 'params.router_id')} />
        </div>
      );
    case 'switch_port_quarantine':
    case 'switch_port_disable':
      return (
        <div className="space-y-3">
          <p className="text-xs text-muted">{tx.portControlHint}</p>
          {step.action === 'switch_port_quarantine' && (
            <Field label={tx.quarantineReason} error={err(errors, 'params.reason')}>
              {(id) => <Input id={id} dir="auto" maxLength={500} value={str(p.reason)} onChange={(e) => set('reason', e.target.value)} />}
            </Field>
          )}
          {devicePicker}
        </div>
      );
    case 'config_backup':
      return (
        <div className="space-y-3">
          <p className="text-xs text-muted">{tx.backupHint}</p>
          <BackupTargetPicker value={(p.target_id as string | null) ?? null} onChange={(v) => set('target_id', v)} siteId={siteId} error={err(errors, 'params.target_id')} />
          {!p.target_id && (
            <div>
              <DevicePicker value={(p.device_id as string | null) ?? null} onChange={(v) => set('device_id', v)} label={tx.device} allowTrigger={!scheduled} siteId={siteId} />
              {err(errors, 'params.device_id') && <p className="mt-1 text-xs text-crit">{err(errors, 'params.device_id')}</p>}
            </div>
          )}
        </div>
      );
    case 'endpoint_command':
      return (
        <div className="space-y-3">
          <p className="text-xs text-muted">{tx.endpointHint}</p>
          <CommandEditor value={(p.command as Params) ?? { kind: 'refresh_inventory' }} onChange={(c) => set('command', c)} kinds={catalog.endpoint_command_kinds} errors={errors} />
          {devicePicker}
          {err(errors, 'params.endpoint_id') && <p className="text-xs text-crit">{err(errors, 'params.endpoint_id')}</p>}
        </div>
      );
    case 'incident_comment':
      return (
        <div className="space-y-3">
          <Field label={tx.body} hint={tx.placeholders} error={err(errors, 'params.body')}>
            {(id) => <Textarea id={id} dir="auto" maxLength={2000} value={str(p.body)} onChange={(e) => set('body', e.target.value)} />}
          </Field>
          <label className="inline-flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={p.include_previous_output !== false} onChange={(e) => set('include_previous_output', e.target.checked)} />
            {tx.includePrevious}
          </label>
        </div>
      );
    case 'wait':
      return (
        <Field label={tx.seconds} error={err(errors, 'params.seconds')}>
          {(id) => <Input id={id} type="number" min={5} max={3600} value={numOr(p.seconds, 60)} onChange={(e) => set('seconds', Number(e.target.value))} />}
        </Field>
      );
    case 'condition': {
      const test = str(p.test) || 'device_online';
      return (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tx.test}>
              {(id) => (
                <Select
                  id={id}
                  value={test}
                  onChange={(e) => {
                    const next: Params = { ...p, test: e.target.value };
                    if (e.target.value === 'check_state') next.states = ['down'];
                    else delete next.states;
                    onChange(next);
                  }}
                >
                  {catalog.condition_tests.map((c) => (
                    <option key={c} value={c}>
                      {conditionLabel(c, locale)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={tx.ifTrue}>
              {(id) => (
                <Select id={id} value={str(p.if_true) || 'continue'} onChange={(e) => set('if_true', e.target.value)}>
                  <option value="continue">{tx.ifTrueContinue}</option>
                  <option value="stop">{tx.ifTrueStop}</option>
                </Select>
              )}
            </Field>
          </div>
          {test === 'check_state' && (
            <>
              <CheckPicker value={(p.check_id as string | null) ?? null} onChange={(v) => set('check_id', v)} siteId={siteId} error={err(errors, 'params.check_id')} />
              <CheckList label={tx.states} options={CHECK_STATES.map((s) => ({ value: s, label: tx.checkStates[s] }))} value={(p.states as (typeof CHECK_STATES)[number][]) ?? []} onChange={(v) => set('states', v)} />
              {err(errors, 'params.states', 'params') && <p className="text-xs text-crit">{err(errors, 'params.states', 'params')}</p>}
            </>
          )}
          {(test === 'device_online' || test === 'device_offline') && (
            <div>
              <DevicePicker value={(p.device_id as string | null) ?? null} onChange={(v) => set('device_id', v)} label={tx.device} allowTrigger={!scheduled} siteId={siteId} />
              {err(errors, 'params.device_id') && <p className="mt-1 text-xs text-crit">{err(errors, 'params.device_id')}</p>}
            </div>
          )}
        </div>
      );
    }
    case 'approval':
      return (
        <Field label={tx.gateMessage} error={err(errors, 'params.message')}>
          {(id) => <Textarea id={id} dir="auto" maxLength={500} value={str(p.message)} onChange={(e) => set('message', e.target.value)} />}
        </Field>
      );
    default:
      return devicePicker;
  }
}

/** One step card: action, risk/approval, label, on-error, and its parameters. */
export function StepEditor({
  index,
  count,
  step,
  onChange,
  onMove,
  onRemove,
  catalog,
  trigger,
  siteId,
  approvalMode,
  errors,
}: {
  index: number;
  count: number;
  step: StepDef;
  onChange: (s: StepDef) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  catalog: Catalog;
  trigger: Trigger;
  siteId: string | null;
  approvalMode: 'always_ask' | 'run_automatically';
  errors: StepErrors;
}) {
  const tx = usePbText();
  const { locale } = useI18n();
  const info = catalog.actions.find((a) => a.key === step.action);
  // Same rule as the API's riskOf(): set_trust is disruptive only when it marks a device unwanted.
  const disruptive = step.action === 'set_trust' ? step.params.trust === 'unwanted' : info?.default_risk === 'disruptive';
  const asks = info?.always_approve || (disruptive && approvalMode === 'always_ask');
  return (
    <li className="space-y-3 rounded-[var(--radius-card)] border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="tnum flex size-6 items-center justify-center rounded-full bg-raised text-xs font-semibold">{index + 1}</span>
          <Select
            aria-label={tx.stepN.replace('{n}', String(index + 1))}
            value={step.action}
            className="w-64"
            onChange={(e) => {
              const action = e.target.value as ActionKey;
              onChange({ ...step, action, params: defaultParams(action) });
            }}
          >
            {catalog.actions.map((a) => (
              <option key={a.key} value={a.key}>
                {actionLabel(a.key, locale)}
              </option>
            ))}
          </Select>
          {info?.always_approve ? <Badge tone="warn">{tx.alwaysAsks}</Badge> : disruptive ? <Badge tone={asks ? 'warn' : 'crit'}>{asks ? tx.disruptive : tx.autoBadge}</Badge> : <Badge tone="idle">{tx.lowRisk}</Badge>}
          {info?.needs_incident && <Badge tone="info" dot={false}>{tx.needsIncident}</Badge>}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" aria-label={tx.moveUp} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="size-3.5" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" aria-label={tx.moveDown} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown className="size-3.5" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" aria-label={tx.removeStep} disabled={count === 1} onClick={onRemove}>
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
      {err(errors, 'action') && <p className="text-xs text-crit">{err(errors, 'action')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tx.stepLabel} error={err(errors, 'label')}>
          {(id) => <Input id={id} dir="auto" maxLength={120} value={step.label ?? ''} onChange={(e) => onChange({ ...step, label: e.target.value || undefined })} />}
        </Field>
        <Field label={tx.onError}>
          {(id) => (
            <Select id={id} value={step.on_error ?? 'stop'} onChange={(e) => onChange({ ...step, on_error: e.target.value as 'stop' | 'continue' })}>
              <option value="stop">{tx.onErrorStop}</option>
              <option value="continue">{tx.onErrorContinue}</option>
            </Select>
          )}
        </Field>
      </div>
      {err(errors, 'key') && <p className="text-xs text-crit">{err(errors, 'key')}</p>}
      <ParamsEditor step={step} onChange={(params) => onChange({ ...step, params })} catalog={catalog} trigger={trigger} siteId={siteId} errors={errors} />
    </li>
  );
}
