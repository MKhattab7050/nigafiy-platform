'use client';

import { Activity, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { FleetGroup, FleetMonitorKind, FleetMonitorRule, FleetMonitorState } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Switch } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';

// Nigafiy Fleet → Monitoring: rules per group (CPU, memory, disk free, service state, event log or
// journal) with thresholds and durations. A breach that lasts the duration raises a Watch event and
// an incident; the first healthy measurement resolves it. Admins edit; everyone else reads.

const en = {
  title: 'Monitoring',
  subtitle: 'Rules checked on every heartbeat of the managed computers. A breach that lasts the rule’s duration raises a Watch alert and an incident; the first healthy measurement resolves it. Nothing is raised or resolved when a value was not measured.',
  newRule: 'New rule',
  editRule: 'Edit rule',
  noRules: 'No monitoring rule yet.',
  rules: 'Rules',
  breaches: 'Current breaches',
  noBreaches: 'No computer breaches a rule right now.',
  name: 'Name',
  kind: 'What to watch',
  kinds: { cpu: 'CPU use', memory: 'Memory use', disk_free: 'Disk free space', service: 'Service state', event_log: 'Event log / journal' } as Record<FleetMonitorKind, string>,
  group: 'Applies to',
  allComputers: 'Every managed computer',
  threshold: 'Threshold',
  cpuHint: 'Alert when use stays above this percentage.',
  diskHint: 'Alert when free space stays below this value. Leave the volume empty to watch every volume.',
  unit: 'Unit',
  pct: 'percent',
  gb: 'GB',
  mount: 'Volume (C: or /)',
  serviceName: 'Service name',
  serviceHint: 'The Windows service name (Spooler), systemd unit (sshd.service) or launchd label. Alert when it is not running or does not exist.',
  eventLog: 'Log name',
  eventLogHint: 'Windows: System, Application or another log. Linux reads the systemd journal (the source is the unit). macOS is not measured.',
  eventSource: 'Source / unit (optional)',
  eventIds: 'Event IDs (Windows, comma separated)',
  eventLevel: 'Level',
  levels: { any: 'Any', warning: 'Warning or worse', error: 'Error or worse', critical: 'Critical' } as Record<string, string>,
  matchText: 'Message contains (optional)',
  window: 'Window (minutes)',
  count: 'Alert at this many entries',
  duration: 'Must last (seconds)',
  durationHint: '0 alerts on the first breaching heartbeat (every 20 seconds).',
  severity: 'Severity',
  sev: { warning: 'Warning', critical: 'Critical' } as Record<string, string>,
  enabled: 'Enabled',
  off: 'Off',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  confirmDelete: (n: string) => `Delete the rule “${n}”? Its open alerts are resolved.`,
  computer: 'Computer',
  rule: 'Rule',
  value: 'Last measurement',
  since: 'Breaching since',
  alerted: 'Alert raised',
  waiting: 'waiting for the duration',
  counts: (b: number, a: number) => `${b} breaching · ${a} alerted`,
  lasts: (s: number) => (s === 0 ? 'at once' : s % 60 === 0 ? `for ${s / 60} min` : `for ${s} s`),
};
type Text = typeof en;

const ar: Text = {
  title: 'المراقبة',
  subtitle: 'قواعد تُفحص مع كل نبضة من الحواسيب المُدارة. الخرق الذي يدوم مدة القاعدة يرفع تنبيهًا في Watch وحادثة؛ وأول قياس سليم يحلّها. لا يُرفع شيء ولا يُحلّ حين لم تُقَس القيمة.',
  newRule: 'قاعدة جديدة',
  editRule: 'تعديل القاعدة',
  noRules: 'لا توجد قاعدة مراقبة بعد.',
  rules: 'القواعد',
  breaches: 'الخروقات الحالية',
  noBreaches: 'لا يخرق أي حاسوب قاعدةً الآن.',
  name: 'الاسم',
  kind: 'ما يُراقَب',
  kinds: { cpu: 'استخدام المعالج', memory: 'استخدام الذاكرة', disk_free: 'المساحة الحرة على القرص', service: 'حالة خدمة', event_log: 'سجل الأحداث / journal' },
  group: 'تنطبق على',
  allComputers: 'كل الحواسيب المُدارة',
  threshold: 'العتبة',
  cpuHint: 'نبّه حين يبقى الاستخدام فوق هذه النسبة.',
  diskHint: 'نبّه حين تبقى المساحة الحرة تحت هذه القيمة. اترك وحدة التخزين فارغة لمراقبة كل الوحدات.',
  unit: 'الوحدة',
  pct: 'نسبة مئوية',
  gb: 'غيغابايت',
  mount: 'وحدة التخزين (C: أو /)',
  serviceName: 'اسم الخدمة',
  serviceHint: 'اسم خدمة Windows ‏(Spooler) أو وحدة systemd ‏(sshd.service) أو تسمية launchd. نبّه حين لا تعمل أو لا توجد.',
  eventLog: 'اسم السجل',
  eventLogHint: 'في Windows: ‏System أو Application أو سجل آخر. في Linux يُقرأ journal الخاص بـ systemd (المصدر هو الوحدة). لا يُقاس في macOS.',
  eventSource: 'المصدر / الوحدة (اختياري)',
  eventIds: 'معرّفات الأحداث (Windows، مفصولة بفواصل)',
  eventLevel: 'المستوى',
  levels: { any: 'أي مستوى', warning: 'تحذير أو أسوأ', error: 'خطأ أو أسوأ', critical: 'حرج' },
  matchText: 'تحتوي الرسالة على (اختياري)',
  window: 'النافذة (دقائق)',
  count: 'نبّه عند هذا العدد من الإدخالات',
  duration: 'يجب أن يدوم (ثوانٍ)',
  durationHint: '0 ينبّه عند أول نبضة خارقة (كل 20 ثانية).',
  severity: 'الخطورة',
  sev: { warning: 'تحذير', critical: 'حرج' },
  enabled: 'مفعّلة',
  off: 'متوقفة',
  save: 'حفظ',
  cancel: 'إلغاء',
  delete: 'حذف',
  confirmDelete: (n: string) => `حذف القاعدة «${n}»؟ تُحلّ تنبيهاتها المفتوحة.`,
  computer: 'الحاسوب',
  rule: 'القاعدة',
  value: 'آخر قياس',
  since: 'خارقة منذ',
  alerted: 'رُفع التنبيه',
  waiting: 'بانتظار انقضاء المدة',
  counts: (b: number, a: number) => `${b} خارقة · ${a} نُبّه عنها`,
  lasts: (s: number) => (s === 0 ? 'فورًا' : s % 60 === 0 ? `لمدة ${s / 60} دقيقة` : `لمدة ${s} ثانية`),
};

const monitorText = (locale: string): Text => (locale === 'ar' ? ar : en);

function ruleSummary(r: FleetMonitorRule, tx: Text): string {
  switch (r.kind) {
    case 'cpu':
    case 'memory':
      return `> ${r.threshold}%`;
    case 'disk_free':
      return `${r.mount ?? '*'} < ${r.threshold}${r.threshold_unit === 'gb' ? ' GB' : '%'}`;
    case 'service':
      return r.service_name ?? '';
    case 'event_log':
      return `${r.event_log}${r.event_source ? ` / ${r.event_source}` : ''}${r.event_ids?.length ? ` #${r.event_ids.join(',')}` : ''} ≥ ${r.threshold} / ${r.event_window_minutes} min · ${tx.levels[r.event_level ?? 'any']}`;
  }
}

export function FleetMonitoringScreen() {
  const { locale } = useI18n();
  const tx = monitorText(locale);
  const { can } = useApp();
  const canAdmin = can('admin');
  const rulesQ = useQuery<{ rules: FleetMonitorRule[] }>('/fleet/monitoring/rules', ['devices', 'events'], 30_000);
  const statesQ = useQuery<{ states: FleetMonitorState[] }>('/fleet/monitoring/states?breaching=1', ['devices', 'events'], 20_000);
  const [editing, setEditing] = useState<FleetMonitorRule | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(r: FleetMonitorRule) {
    if (!window.confirm(tx.confirmDelete(r.name))) return;
    setError(null);
    try {
      await api(`/fleet/monitoring/rules/${r.id}`, { method: 'DELETE' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
    void rulesQ.reload();
    void statesQ.reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={tx.title}
        description={tx.subtitle}
        icon={<Activity className="size-5" aria-hidden />}
        actions={
          canAdmin ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden />
              {tx.newRule}
            </Button>
          ) : undefined
        }
      />
      {error && (
        <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
          {error}
        </p>
      )}
      <section className="space-y-2" aria-labelledby="mon-breaches">
        <h2 id="mon-breaches" className="text-sm font-semibold">
          {tx.breaches}
        </h2>
        <Card padded={false}>
          <Async query={statesQ}>
            {({ states }) =>
              states.length === 0 ? (
                <p className="p-5 text-sm text-muted">{tx.noBreaches}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {states.map((s) => (
                    <li key={`${s.rule_id}:${s.endpoint_id}`} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                      <div className="min-w-0 flex-[1_1_22rem] space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link href={`/fleet/endpoints/${s.endpoint_id}`} className="font-medium text-accent-hover hover:underline" dir="auto">
                            {s.endpoint_name}
                          </Link>
                          <span dir="auto">{s.rule_name}</span>
                          <Badge tone={s.alerted_at ? (s.severity === 'critical' ? 'crit' : 'warn') : 'idle'}>{s.alerted_at ? tx.sev[s.severity] : tx.waiting}</Badge>
                        </div>
                        {s.last_value && <p className="text-[13px] text-muted">{ltr(s.last_value)}</p>}
                      </div>
                      <p className="text-xs text-faint">
                        {tx.since} {relativeTime(s.breached_since, locale)}
                        {s.alerted_at ? ` · ${tx.alerted} ${relativeTime(s.alerted_at, locale)}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )
            }
          </Async>
        </Card>
      </section>
      <section className="space-y-2" aria-labelledby="mon-rules">
        <h2 id="mon-rules" className="text-sm font-semibold">
          {tx.rules}
        </h2>
        <Card padded={false}>
          <Async query={rulesQ}>
            {({ rules }) =>
              rules.length === 0 ? (
                <p className="p-5 text-sm text-muted">{tx.noRules}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {rules.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                      <div className="min-w-0 flex-[1_1_22rem] space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-medium" dir="auto">
                            {r.name}
                          </span>
                          <Badge tone="idle">{tx.kinds[r.kind]}</Badge>
                          <Badge tone={r.severity === 'critical' ? 'crit' : 'warn'}>{tx.sev[r.severity]}</Badge>
                          {!r.enabled && <Badge tone="idle">{tx.off}</Badge>}
                        </div>
                        <p className="text-[13px] text-muted">
                          {ltr(ruleSummary(r, tx))} · {tx.lasts(r.duration_seconds)} ·{' '}
                          <span dir="auto">{r.fleet_group_name ?? tx.allComputers}</span>
                        </p>
                        <p className="text-xs text-faint">{tx.counts(r.breaching, r.alerting)}</p>
                      </div>
                      {canAdmin && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button size="sm" onClick={() => setEditing(r)}>
                            {tx.editRule}
                          </Button>
                          <Button size="sm" onClick={() => void remove(r)} aria-label={`${tx.delete}: ${r.name}`}>
                            <Trash2 className="size-3.5" aria-hidden />
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )
            }
          </Async>
        </Card>
      </section>
      {editing && canAdmin && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          tx={tx}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void rulesQ.reload();
            void statesQ.reload();
          }}
        />
      )}
    </div>
  );
}

const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

function RuleEditor({ rule, tx, onClose, onSaved }: { rule: FleetMonitorRule | null; tx: Text; onClose: () => void; onSaved: () => void }) {
  const groupsQ = useQuery<{ groups: FleetGroup[] }>('/fleet/groups', ['devices'], 60_000);
  const [name, setName] = useState(rule?.name ?? '');
  const [kind, setKind] = useState<FleetMonitorKind>(rule?.kind ?? 'cpu');
  const [group, setGroup] = useState(rule?.fleet_group_id ?? '');
  const [threshold, setThreshold] = useState(rule?.threshold === null || rule?.threshold === undefined ? '90' : String(rule.threshold));
  const [unit, setUnit] = useState<'pct' | 'gb'>(rule?.threshold_unit === 'gb' ? 'gb' : 'pct');
  const [mount, setMount] = useState(rule?.mount ?? '');
  const [service, setService] = useState(rule?.service_name ?? '');
  const [log, setLog] = useState(rule?.event_log ?? 'System');
  const [source, setSource] = useState(rule?.event_source ?? '');
  const [ids, setIds] = useState((rule?.event_ids ?? []).join(', '));
  const [level, setLevel] = useState(rule?.event_level ?? 'error');
  const [match, setMatch] = useState(rule?.match_text ?? '');
  const [windowMin, setWindowMin] = useState(String(rule?.event_window_minutes ?? 60));
  const [duration, setDuration] = useState(String(rule?.duration_seconds ?? 300));
  const [severity, setSeverity] = useState<'warning' | 'critical'>(rule?.severity ?? 'warning');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      name: name.trim(),
      kind,
      fleet_group_id: group || null,
      duration_seconds: Number(duration),
      severity,
      enabled,
    };
    if (kind === 'cpu' || kind === 'memory') body.threshold = numOrNull(threshold);
    if (kind === 'disk_free') Object.assign(body, { threshold: numOrNull(threshold), threshold_unit: unit, mount: mount.trim() || null });
    if (kind === 'service') body.service_name = service.trim() || null;
    if (kind === 'event_log')
      Object.assign(body, {
        threshold: numOrNull(threshold),
        event_log: log.trim() || null,
        event_source: source.trim() || null,
        event_ids: ids.trim() ? ids.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n)) : null,
        event_level: level,
        match_text: match.trim() || null,
        event_window_minutes: numOrNull(windowMin),
      });
    try {
      if (rule) await api(`/fleet/monitoring/rules/${rule.id}`, { method: 'PUT', body });
      else await api('/fleet/monitoring/rules', { method: 'POST', body });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? [err.message, ...(err.details ?? []).map((d) => d.message)].join(' ') : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={rule ? tx.editRule : tx.newRule} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.name}>{(id) => <Input id={id} value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} dir="auto" autoFocus />}</Field>
          <Field label={tx.kind}>
            {(id) => (
              <Select
                id={id}
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as FleetMonitorKind;
                  setKind(k);
                  setThreshold(k === 'event_log' ? '1' : k === 'disk_free' ? '10' : '90');
                }}
              >
                {(['cpu', 'memory', 'disk_free', 'service', 'event_log'] as const).map((k) => (
                  <option key={k} value={k}>
                    {tx.kinds[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={tx.group}>
            {(id) => (
              <Select id={id} value={group} onChange={(e) => setGroup(e.target.value)}>
                <option value="">{tx.allComputers}</option>
                {(groupsQ.data?.groups ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={tx.severity}>
            {(id) => (
              <Select id={id} value={severity} onChange={(e) => setSeverity(e.target.value as 'warning' | 'critical')}>
                <option value="warning">{tx.sev.warning}</option>
                <option value="critical">{tx.sev.critical}</option>
              </Select>
            )}
          </Field>
        </div>

        {(kind === 'cpu' || kind === 'memory') && (
          <Field label={`${tx.threshold} (%)`} hint={tx.cpuHint}>
            {(id) => <Input id={id} type="number" min={1} max={100} value={threshold} onChange={(e) => setThreshold(e.target.value)} dir="ltr" required />}
          </Field>
        )}
        {kind === 'disk_free' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={tx.threshold} hint={tx.diskHint}>
              {(id) => <Input id={id} type="number" min={0} step="0.1" value={threshold} onChange={(e) => setThreshold(e.target.value)} dir="ltr" required />}
            </Field>
            <Field label={tx.unit}>
              {(id) => (
                <Select id={id} value={unit} onChange={(e) => setUnit(e.target.value as 'pct' | 'gb')}>
                  <option value="pct">{tx.pct}</option>
                  <option value="gb">{tx.gb}</option>
                </Select>
              )}
            </Field>
            <Field label={tx.mount}>{(id) => <Input id={id} value={mount} maxLength={120} onChange={(e) => setMount(e.target.value)} dir="ltr" />}</Field>
          </div>
        )}
        {kind === 'service' && (
          <Field label={tx.serviceName} hint={tx.serviceHint}>
            {(id) => <Input id={id} value={service} maxLength={256} onChange={(e) => setService(e.target.value)} dir="ltr" required />}
          </Field>
        )}
        {kind === 'event_log' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tx.eventLog} hint={tx.eventLogHint}>
              {(id) => <Input id={id} value={log} maxLength={256} onChange={(e) => setLog(e.target.value)} dir="ltr" required />}
            </Field>
            <Field label={tx.eventSource}>{(id) => <Input id={id} value={source} maxLength={256} onChange={(e) => setSource(e.target.value)} dir="ltr" />}</Field>
            <Field label={tx.eventIds}>{(id) => <Input id={id} value={ids} onChange={(e) => setIds(e.target.value)} dir="ltr" />}</Field>
            <Field label={tx.eventLevel}>
              {(id) => (
                <Select id={id} value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
                  {(['any', 'warning', 'error', 'critical'] as const).map((l) => (
                    <option key={l} value={l}>
                      {tx.levels[l]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={tx.matchText}>{(id) => <Input id={id} value={match} maxLength={200} onChange={(e) => setMatch(e.target.value)} dir="auto" />}</Field>
            <Field label={tx.window}>{(id) => <Input id={id} type="number" min={1} max={1440} value={windowMin} onChange={(e) => setWindowMin(e.target.value)} dir="ltr" required />}</Field>
            <Field label={tx.count}>{(id) => <Input id={id} type="number" min={1} value={threshold} onChange={(e) => setThreshold(e.target.value)} dir="ltr" required />}</Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.duration} hint={tx.durationHint}>
            {(id) => <Input id={id} type="number" min={0} max={86400} value={duration} onChange={(e) => setDuration(e.target.value)} dir="ltr" />}
          </Field>
          <div className="flex items-center gap-2 pt-6 text-sm">
            <Switch checked={enabled} onChange={setEnabled} label={tx.enabled} />
            <span>{tx.enabled}</span>
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {tx.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
            {tx.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
