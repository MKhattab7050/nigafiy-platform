'use client';

import { Archive, FileCode2, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FleetScript, FleetScriptOs, FleetScriptParam, FleetScriptParamType, FleetScriptVersion } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Switch, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { JobDialog, jobsError } from '../components/fleet-jobs/job-dialog';
import { jobsText } from '../components/fleet-jobs/jobs-text';

interface ParamDraft {
  name: string;
  type: FleetScriptParamType;
  label: string;
  required: boolean;
  default: string;
  choices: string;
  min: string;
  max: string;
  max_length: string;
}

const toDraft = (p: FleetScriptParam): ParamDraft => ({
  name: p.name,
  type: p.type,
  label: p.label ?? '',
  required: p.required,
  default: p.default === null || p.default === undefined ? '' : String(p.default),
  choices: (p.choices ?? []).join(', '),
  min: p.min === null ? '' : String(p.min),
  max: p.max === null ? '' : String(p.max),
  max_length: p.max_length === null ? '' : String(p.max_length),
});

const num = (s: string) => (s.trim() === '' ? null : Number(s));

/** The API shape of a parameter draft (the server validates it again). */
function fromDraft(d: ParamDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { name: d.name.trim(), type: d.type, required: d.required };
  if (d.label.trim()) out.label = d.label.trim();
  if (d.type === 'choice') out.choices = d.choices.split(',').map((c) => c.trim()).filter(Boolean);
  if (d.type === 'int') {
    if (num(d.min) !== null) out.min = num(d.min);
    if (num(d.max) !== null) out.max = num(d.max);
  }
  if (d.type === 'string' && num(d.max_length) !== null) out.max_length = num(d.max_length);
  if (d.default.trim() !== '') out.default = d.type === 'int' ? Number(d.default) : d.type === 'bool' ? d.default === 'true' : d.default;
  return out;
}

/** Nigafiy Fleet → Scripts: the library. Admins edit; technicians see and run the scripts marked for them; viewers have no access. */
export function FleetScriptsScreen() {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const { can } = useApp();
  const canAdmin = can('admin');
  const router = useRouter();
  const [archived, setArchived] = useState(false);
  const q = useQuery<{ scripts: FleetScript[] }>(`/fleet/scripts?archived=${archived}`, ['devices'], 60_000);
  const [editing, setEditing] = useState<FleetScript | 'new' | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [versionsOf, setVersionsOf] = useState<FleetScript | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function toggleArchive(s: FleetScript) {
    setError(null);
    try {
      await api(`/fleet/scripts/${s.id}/${s.archived_at ? 'restore' : 'archive'}`, { method: 'POST', body: {} });
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    }
    void q.reload();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={tx.scriptsTitle}
        description={tx.scriptsSubtitle}
        icon={<FileCode2 className="size-5" aria-hidden />}
        actions={
          canAdmin ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus className="size-4" aria-hidden />
              {tx.newScript}
            </Button>
          ) : undefined
        }
      />
      {canAdmin && (
        <div className="flex items-center gap-2 text-sm">
          <Switch checked={archived} onChange={setArchived} label={tx.showArchived} />
          <span>{tx.showArchived}</span>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
          {jobsError(tx, error, locale)}
        </p>
      )}
      <Card padded={false}>
        <Async query={q}>
          {({ scripts }) =>
            scripts.length === 0 ? (
              <p className="p-5 text-sm text-muted">{tx.noScripts}</p>
            ) : (
              <ul className="divide-y divide-line">
                {scripts.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-[1_1_22rem] space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium" dir="auto">
                          {s.name}
                        </span>
                        <Badge tone="idle">{tx.osName[s.os]}</Badge>
                        <Badge tone={s.technician_runnable ? 'ok' : 'idle'}>{s.technician_runnable ? tx.techOnly : tx.adminsOnly}</Badge>
                        <button type="button" className="mono text-xs text-accent-hover hover:underline" onClick={() => setVersionsOf(s)}>
                          {ltr(tx.version(s.current_version))}
                        </button>
                        {s.archived_at && <Badge tone="warn">{tx.archive}</Badge>}
                      </div>
                      {s.description && (
                        <p className="text-[13px] text-muted" dir="auto">
                          {s.description}
                        </p>
                      )}
                      <p className="text-xs text-faint">
                        {s.current.parameters.map((p) => ltr(`${p.name}:${p.type}`)).join(' · ')}
                        {s.current.parameters.length > 0 ? ' · ' : ''}
                        {tx.lines(s.current.body.split('\n').length)} · {absoluteTime(s.updated_at, locale)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {!s.archived_at && (
                        <Button size="sm" variant="primary" onClick={() => setRunning(s.id)}>
                          <Play className="size-3.5" aria-hidden />
                          {tx.runJob}
                        </Button>
                      )}
                      {canAdmin && !s.archived_at && (
                        <Button size="sm" onClick={() => setEditing(s)}>
                          {tx.editScript}
                        </Button>
                      )}
                      {canAdmin && (
                        <Button size="sm" onClick={() => void toggleArchive(s)}>
                          {s.archived_at ? <RotateCcw className="size-3.5" aria-hidden /> : <Archive className="size-3.5" aria-hidden />}
                          {s.archived_at ? tx.restore : tx.archive}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      </Card>
      {editing && (
        <ScriptEditor
          script={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void q.reload();
          }}
        />
      )}
      {versionsOf && <VersionsDialog script={versionsOf} onClose={() => setVersionsOf(null)} />}
      {running && <JobDialog scriptId={running} onClose={() => setRunning(null)} onCreated={(job) => router.push(`/fleet/jobs/${job.id}`)} />}
    </div>
  );
}

function ScriptEditor({ script, onClose, onSaved }: { script: FleetScript | null; onClose: () => void; onSaved: () => void }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const [name, setName] = useState(script?.name ?? '');
  const [description, setDescription] = useState(script?.description ?? '');
  const [os, setOs] = useState<FleetScriptOs>(script?.os ?? 'windows');
  const [body, setBody] = useState(script?.current.body ?? '');
  const [timeout, setTimeoutS] = useState(script?.current.timeout_s ?? 600);
  const [tech, setTech] = useState(script?.technician_runnable ?? false);
  const [note, setNote] = useState('');
  const [params, setParams] = useState<ParamDraft[]>((script?.current.parameters ?? []).map(toDraft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const lang = os === 'windows' ? 'powershell' : 'sh';
  const ready = name.trim().length > 0 && body.trim().length > 0 && params.every((p) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(p.name.trim()));

  const setParam = (i: number, patch: Partial<ParamDraft>) => setParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const common = { name: name.trim(), description: description.trim() || null, technician_runnable: tech, body, parameters: params.map(fromDraft), timeout_s: timeout, note: note.trim() || null };
      if (script) await api(`/fleet/scripts/${script.id}`, { method: 'PATCH', body: common });
      else await api('/fleet/scripts', { method: 'POST', body: { ...common, os } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={script ? tx.editScript : tx.newScript} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.name}>{(id) => <Input id={id} value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} dir="auto" autoFocus />}</Field>
          <Field label={tx.os}>
            {(id) => (
              <Select id={id} value={os} disabled={Boolean(script)} onChange={(e) => setOs(e.target.value as FleetScriptOs)}>
                {(['windows', 'linux', 'macos'] as const).map((o) => (
                  <option key={o} value={o}>
                    {tx.osName[o]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label={tx.description}>{(id) => <Input id={id} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} dir="auto" />}</Field>
        <Field label={tx.body} hint={tx.bodyHint(lang)}>
          {(id) => <Textarea id={id} value={body} onChange={(e) => setBody(e.target.value)} rows={12} spellCheck={false} className="mono text-xs" dir="ltr" required />}
        </Field>

        <fieldset className="space-y-2 rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-medium text-muted">{tx.parameters}</legend>
          {params.map((p, i) => (
            <div key={i} className="grid gap-2 rounded-md bg-raised/50 p-2 sm:grid-cols-6">
              <Input aria-label={tx.paramName} placeholder={tx.paramName} value={p.name} maxLength={40} onChange={(e) => setParam(i, { name: e.target.value })} dir="ltr" className="sm:col-span-2" />
              <Select aria-label={tx.paramType} value={p.type} onChange={(e) => setParam(i, { type: e.target.value as FleetScriptParamType })}>
                {(['string', 'int', 'bool', 'choice'] as const).map((t) => (
                  <option key={t} value={t}>
                    {tx.paramTypes[t]}
                  </option>
                ))}
              </Select>
              <Input aria-label={tx.paramLabel} placeholder={tx.paramLabel} value={p.label} maxLength={80} onChange={(e) => setParam(i, { label: e.target.value })} dir="auto" className="sm:col-span-2" />
              <Button type="button" size="sm" onClick={() => setParams(params.filter((_, j) => j !== i))} aria-label={tx.removeParam(p.name || String(i + 1))}>
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
              <label className="flex items-center gap-2 text-xs sm:col-span-1">
                <input type="checkbox" checked={p.required} onChange={(e) => setParam(i, { required: e.target.checked })} />
                {tx.paramRequired}
              </label>
              {p.type === 'bool' ? (
                <Select aria-label={tx.paramDefault} value={p.default} onChange={(e) => setParam(i, { default: e.target.value })} className="sm:col-span-2">
                  <option value="">{tx.paramDefault}: —</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </Select>
              ) : (
                <Input aria-label={tx.paramDefault} placeholder={tx.paramDefault} value={p.default} onChange={(e) => setParam(i, { default: e.target.value })} dir="auto" className="sm:col-span-2" />
              )}
              {p.type === 'choice' && <Input aria-label={tx.paramChoices} placeholder={tx.paramChoices} value={p.choices} onChange={(e) => setParam(i, { choices: e.target.value })} dir="auto" className="sm:col-span-3" />}
              {p.type === 'int' && (
                <>
                  <Input aria-label={tx.paramMin} placeholder={tx.paramMin} type="number" value={p.min} onChange={(e) => setParam(i, { min: e.target.value })} dir="ltr" />
                  <Input aria-label={tx.paramMax} placeholder={tx.paramMax} type="number" value={p.max} onChange={(e) => setParam(i, { max: e.target.value })} dir="ltr" />
                </>
              )}
              {p.type === 'string' && <Input aria-label={tx.paramMaxLength} placeholder={tx.paramMaxLength} type="number" value={p.max_length} onChange={(e) => setParam(i, { max_length: e.target.value })} dir="ltr" />}
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            disabled={params.length >= 20}
            onClick={() => setParams([...params, { name: '', type: 'string', label: '', required: false, default: '', choices: '', min: '', max: '', max_length: '' }])}
          >
            <Plus className="size-3.5" aria-hidden />
            {tx.addParam}
          </Button>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tx.timeout}>{(id) => <Input id={id} type="number" min={10} max={86400} value={timeout} onChange={(e) => setTimeoutS(Number(e.target.value))} dir="ltr" />}</Field>
          <Field label={tx.versionNote}>{(id) => <Input id={id} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} dir="auto" />}</Field>
        </div>
        <div className="flex items-start gap-2">
          <Switch checked={tech} onChange={setTech} label={tx.techRunnable} />
          <div className="text-sm">
            <p>{tx.techRunnable}</p>
            <p className="text-xs text-muted">{tx.techRunnableHint}</p>
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-sm">
            {jobsError(tx, error, locale)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {tx.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
            {tx.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VersionsDialog({ script, onClose }: { script: FleetScript; onClose: () => void }) {
  const { locale } = useI18n();
  const tx = jobsText(locale);
  const q = useQuery<FleetScript & { versions: FleetScriptVersion[] }>(`/fleet/scripts/${script.id}`, ['devices']);
  return (
    <Modal title={`${tx.versions}: ${script.name}`} onClose={onClose} wide>
      <Async query={q}>
        {(s) => (
          <ul className="space-y-3">
            {s.versions.map((v) => (
              <li key={v.version} className="space-y-1 rounded-md border border-line p-3">
                <p className="text-sm font-medium">{tx.versionBy(v.version, v.created_by_email, absoluteTime(v.created_at, locale))}</p>
                {v.note && (
                  <p className="text-xs text-muted" dir="auto">
                    {v.note}
                  </p>
                )}
                <p className="mono text-[11px] text-faint">
                  {tx.sha} {ltr(v.body_sha256)}
                </p>
                <pre className="mono max-h-48 overflow-auto rounded bg-sunken p-2 text-[11px]" dir="ltr">
                  {v.body}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </Async>
    </Modal>
  );
}
