'use client';

import { ArrowLeft, Play, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorNote, Field, Input, Modal, Notice, PageHeader, Select, SkeletonBlock, Switch, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { ApiErrors, DevicePicker, usePbText } from '../components/common';
import { StepEditor, type StepErrors, defaultParams } from '../components/step-editor';
import { TriggerEditor, defaultTrigger } from '../components/trigger-editor';
import { actionLabel } from '../text';
import type { ActionKey, ApprovalMode, Catalog, Playbook, RunDetail, StepDef, Trigger } from '../types';
import { RunsTable } from './runs-screen';

interface Draft {
  name: string;
  description: string;
  site_id: string | null;
  enabled: boolean;
  dry_run: boolean;
  trigger: Trigger;
  steps: StepDef[];
  approval_mode: ApprovalMode;
  max_runs_per_hour: number;
}

const EDITABLE = ['name', 'description', 'site_id', 'enabled', 'dry_run', 'trigger', 'steps', 'approval_mode', 'max_runs_per_hour'] as const;

function draftOf(p: Playbook | null, siteId: string | null): Draft {
  if (!p) return { name: '', description: '', site_id: siteId, enabled: false, dry_run: false, trigger: defaultTrigger('event'), steps: [newStep('notify')], approval_mode: 'always_ask', max_runs_per_hour: 6 };
  return { name: p.name, description: p.description, site_id: p.site_id, enabled: p.enabled, dry_run: p.dry_run, trigger: p.trigger, steps: p.steps, approval_mode: p.approval_mode, max_runs_per_hour: p.max_runs_per_hour };
}

/** A step with its own key, so adding and removing steps never makes two steps share the server's generated key. */
function newStep(action: ActionKey): StepDef {
  return { key: `${action.replace(/_/g, '-')}-${Math.random().toString(36).slice(2, 7)}`, action, on_error: 'stop', params: defaultParams(action) };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Validation details of the API, grouped: top-level field → message, and steps.<i>.<rest> → per step. */
function splitErrors(error: unknown): { fields: Record<string, string>; steps: Record<number, StepErrors> } {
  const fields: Record<string, string> = {};
  const steps: Record<number, StepErrors> = {};
  if (!(error instanceof ApiError) || !error.details) return { fields, steps };
  for (const d of error.details) {
    const m = /^steps\.(\d+)(?:\.(.+))?$/.exec(d.path);
    if (m) {
      const i = Number(m[1]);
      (steps[i] ??= {})[m[2] ?? 'action'] = d.message;
    } else fields[d.path.split('.')[0] ?? d.path] ??= d.message;
  }
  return { fields, steps };
}

function RunNowModal({ playbook, onClose }: { playbook: Playbook; onClose: () => void }) {
  const tx = usePbText();
  const router = useRouter();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(playbook.dry_run);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await api<RunDetail>(`/playbooks/${playbook.id}/run`, { method: 'POST', body: { device_id: deviceId, dry_run: dryRun } });
      router.push(`/playbooks/runs/${run.id}`);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };
  return (
    <Modal title={tx.runTitle} onClose={() => (busy ? undefined : onClose())}>
      <div className="space-y-4">
        <DevicePicker value={deviceId} onChange={setDeviceId} label={tx.runDevice} hint={tx.runDeviceHint} siteId={playbook.site_id} />
        {error?.code === 'device_required' && <p className="text-xs text-warn">{tx.runNeedsDevice}</p>}
        <label className="inline-flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" className="size-3.5 accent-[var(--color-accent)]" checked={dryRun} disabled={playbook.dry_run} onChange={(e) => setDryRun(e.target.checked)} />
          {tx.dryRun}
        </label>
        <p className="text-xs text-muted">{tx.runDryHint}</p>
        {error && error.code !== 'device_required' && <ErrorNote error={error} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            {tx.cancel}
          </Button>
          <Button variant="primary" busy={busy} onClick={() => void start()}>
            <Play className="size-3.5" aria-hidden />
            {tx.start}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Editor({ playbook, catalog, onSaved }: { playbook: Playbook | null; catalog: Catalog; onSaved: (p: Playbook) => void }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const { can, sites, siteId } = useApp();
  const router = useRouter();
  const admin = can('admin');
  const original = useMemo(() => draftOf(playbook, siteId), [playbook, siteId]);
  const [draft, setDraft] = useState<Draft>(original);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addAction, setAddAction] = useState<ActionKey>('notify');

  useEffect(() => {
    setDraft(original);
    setConfirmAuto(false);
  }, [original]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(false);
  };
  const changed = EDITABLE.filter((k) => !same(draft[k], original[k]));
  const definitionChanged = changed.some((k) => k === 'trigger' || k === 'steps' || k === 'site_id');
  // Same rule as the API: confirming again is needed when switching to automatic, or changing an automatic playbook's definition.
  const needsConfirm = draft.approval_mode === 'run_automatically' && (!playbook || original.approval_mode !== 'run_automatically' || definitionChanged);
  const { fields, steps: stepErrors } = splitErrors(error);
  const maxSteps = 20; // stepSchema: .max(20)

  const save = async () => {
    setBusy('save');
    setError(null);
    setSaved(false);
    try {
      const extra = needsConfirm ? { auto_run_confirmed: confirmAuto } : {};
      let p: Playbook;
      if (playbook) {
        const body: Record<string, unknown> = { ...extra };
        for (const k of changed) body[k] = draft[k];
        p = await api<Playbook>(`/playbooks/${playbook.id}`, { method: 'PATCH', body });
      } else {
        p = await api<Playbook>('/playbooks', { method: 'POST', body: { ...draft, ...extra } });
        router.replace(`/playbooks/${p.id}`);
      }
      setSaved(true);
      onSaved(p);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!playbook) return;
    setBusy('delete');
    setError(null);
    try {
      await api(`/playbooks/${playbook.id}`, { method: 'DELETE' });
      router.push('/playbooks');
    } catch (e) {
      setError(e);
      setConfirmDelete(false);
      setBusy(null);
    }
  };

  const moveStep = (i: number, dir: -1 | 1) => {
    const next = [...draft.steps];
    const [s] = next.splice(i, 1);
    next.splice(i + dir, 0, s!);
    set('steps', next);
  };

  return (
    <div className="space-y-5">
      {!admin && <Notice>{tx.readOnlyEditor}</Notice>}
      <fieldset disabled={!admin} className="min-w-0 space-y-5">
        <Card title={tx.name}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={tx.name} error={fields.name}>
              {(id) => <Input id={id} dir="auto" maxLength={120} value={draft.name} onChange={(e) => set('name', e.target.value)} />}
            </Field>
            <Field label={tx.site} hint={tx.siteHint} error={fields.site_id}>
              {(id) => (
                <Select id={id} value={draft.site_id ?? ''} onChange={(e) => set('site_id', e.target.value || null)}>
                  <option value="">{tx.allSites}</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="md:col-span-2">
              <Field label={tx.description} error={fields.description}>
                {(id) => <Textarea id={id} dir="auto" maxLength={2000} value={draft.description} onChange={(e) => set('description', e.target.value)} />}
              </Field>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium">{tx.enabledLabel}</p>
                <p className="mt-0.5 text-xs text-muted">{tx.enabledHint}</p>
              </div>
              <Switch checked={draft.enabled} onChange={(v) => set('enabled', v)} disabled={!admin} label={tx.enabledLabel} />
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[13px] font-medium">{tx.dryRunLabel}</p>
                <p className="mt-0.5 text-xs text-muted">{tx.dryRunHint}</p>
              </div>
              <Switch checked={draft.dry_run} onChange={(v) => set('dry_run', v)} disabled={!admin} label={tx.dryRunLabel} />
            </div>
          </div>
        </Card>

        <Card title={tx.trigger}>
          <TriggerEditor value={draft.trigger} onChange={(t) => set('trigger', t)} catalog={catalog} disabled={!admin} />
          {fields.trigger && <p className="mt-2 text-xs text-crit">{fields.trigger}</p>}
        </Card>

        <Card title={tx.steps} description={fill(tx.stepsCount, { n: draft.steps.length })}>
          {draft.steps.length === 0 ? (
            <p className="text-[13px] text-muted">{tx.noSteps}</p>
          ) : (
            <ol className="space-y-3">
              {draft.steps.map((s, i) => (
                <StepEditor
                  key={s.key ?? i}
                  index={i}
                  count={draft.steps.length}
                  step={s}
                  onChange={(next) => set('steps', draft.steps.map((x, j) => (j === i ? next : x)))}
                  onMove={(dir) => moveStep(i, dir)}
                  onRemove={() => set('steps', draft.steps.filter((_, j) => j !== i))}
                  catalog={catalog}
                  trigger={draft.trigger}
                  siteId={draft.site_id}
                  approvalMode={draft.approval_mode}
                  errors={stepErrors[i] ?? {}}
                />
              ))}
            </ol>
          )}
          {fields.steps && <p className="mt-2 text-xs text-crit">{fields.steps}</p>}
          {admin && draft.steps.length < maxSteps && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select aria-label={tx.addStep} value={addAction} className="w-64" onChange={(e) => setAddAction(e.target.value as ActionKey)}>
                {catalog.actions.map((a) => (
                  <option key={a.key} value={a.key}>
                    {actionLabel(a.key, locale)}
                  </option>
                ))}
              </Select>
              <Button size="sm" onClick={() => set('steps', [...draft.steps, newStep(addAction)])}>
                <Plus className="size-3.5" aria-hidden />
                {tx.addStep}
              </Button>
            </div>
          )}
        </Card>

        <Card title={tx.approvalMode}>
          <div className="space-y-3">
            {(['always_ask', 'run_automatically'] as const).map((m) => (
              <label key={m} className="flex items-start gap-2 text-[13px]">
                <input type="radio" name="approval_mode" className="mt-0.5 accent-[var(--color-accent)]" checked={draft.approval_mode === m} onChange={() => set('approval_mode', m)} />
                {m === 'always_ask' ? tx.modeAsk : tx.modeAuto}
              </label>
            ))}
            {playbook?.auto_run_set_by_email && draft.approval_mode === 'run_automatically' && (
              <p className="text-xs text-muted">{fill(tx.autoSetBy, { who: playbook.auto_run_set_by_email, when: absoluteTime(playbook.auto_run_set_at, locale) })}</p>
            )}
            {needsConfirm && (
              <label className="flex items-start gap-2 rounded-[var(--radius-control)] border border-warn/40 bg-warn/[0.06] px-3 py-2 text-[13px]">
                <input type="checkbox" className="mt-0.5 size-3.5 accent-[var(--color-accent)]" checked={confirmAuto} onChange={(e) => setConfirmAuto(e.target.checked)} />
                {tx.autoConfirm}
              </label>
            )}
            <Field label={tx.maxRuns} error={fields.max_runs_per_hour}>
              {(id) => <Input id={id} type="number" min={1} max={60} className="w-28" value={draft.max_runs_per_hour} onChange={(e) => set('max_runs_per_hour', Number(e.target.value))} />}
            </Field>
          </div>
        </Card>
      </fieldset>

      {error ? <ApiErrors error={error} /> : null}
      {admin && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" busy={busy === 'save'} disabled={(playbook ? changed.length === 0 : false) || (needsConfirm && !confirmAuto) || draft.steps.length === 0} onClick={() => void save()}>
            {playbook ? tx.saveChanges : tx.create}
          </Button>
          {saved && changed.length === 0 && <span className="text-xs text-ok">{tx.saved}</span>}
          {playbook && (
            <Button variant="danger" className="ms-auto" onClick={() => setConfirmDelete(true)}>
              {tx.deletePlaybook}
            </Button>
          )}
        </div>
      )}
      {confirmDelete && (
        <Modal title={tx.deletePlaybook} onClose={() => (busy ? undefined : setConfirmDelete(false))}>
          <p className="text-[13px]">{tx.deleteConfirm}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setConfirmDelete(false)} disabled={busy === 'delete'}>
              {tx.cancel}
            </Button>
            <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>
              {tx.deleteYes}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EditorView({ id }: { id: string }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const { can } = useApp();
  const params = useSearchParams();
  const isNew = id === 'new';
  const catalog = useQuery<Catalog>('/playbooks/catalog', [], 0);
  const query = useQuery<Playbook>(isNew ? null : `/playbooks/${id}`, [], 0);
  const [running, setRunning] = useState(false);
  const playbook = isNew ? null : (query.data ?? null);

  const header = (
    <PageHeader
      title={isNew ? tx.editorNew : (playbook?.name ?? tx.pageTitle)}
      description={playbook ? `${fill(tx.version, { v: playbook.version })}${playbook.created_by_email ? ` · ${fill(tx.createdBy, { who: playbook.created_by_email })}` : ''}` : undefined}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/playbooks" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
            <ArrowLeft className="size-3.5 rtl:rotate-180" aria-hidden />
            {tx.back}
          </Link>
          {playbook && can('technician') && (
            <Button variant="primary" onClick={() => setRunning(true)}>
              <Play className="size-3.5" aria-hidden />
              {tx.runNow}
            </Button>
          )}
        </div>
      }
    />
  );

  if (catalog.error && !catalog.data)
    return (
      <div className="space-y-5">
        {header}
        <p className="text-[13px] text-muted">{tx.catalogError}</p>
        <ErrorNote error={catalog.error} onRetry={catalog.reload} />
      </div>
    );
  if (!isNew && query.error && !query.data)
    return (
      <div className="space-y-5">
        {header}
        {query.error.status === 404 ? <EmptyState title={tx.notFound} action={<Link href="/playbooks" className="text-accent-hover hover:underline">{tx.back}</Link>} /> : <ErrorNote error={query.error} onRetry={query.reload} />}
      </div>
    );
  if (!catalog.data || (!isNew && !query.data))
    return (
      <div className="space-y-5">
        {header}
        <SkeletonBlock lines={6} />
      </div>
    );

  return (
    <div className="space-y-5">
      {header}
      {params.get('created') && <Notice>{tx.templateCreated}</Notice>}
      {playbook && (
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={playbook.enabled ? 'ok' : 'idle'}>{playbook.enabled ? tx.enabled : tx.disabled}</Badge>
          {playbook.dry_run && <Badge tone="info">{tx.dryRunBadge}</Badge>}
          {playbook.approval_mode === 'run_automatically' && <Badge tone="warn">{tx.autoBadge}</Badge>}
          {playbook.next_run_at && <Badge tone="info" dot={false}>{`${tx.nextRun}: ${absoluteTime(playbook.next_run_at, locale)}`}</Badge>}
        </div>
      )}
      <Editor playbook={playbook} catalog={catalog.data} onSaved={() => query.reload()} />
      {playbook && (
        <Card title={tx.recentRuns} padded={false}>
          <RunsTable playbookId={playbook.id} pageSize={5} paged={false} showPlaybook={false} />
        </Card>
      )}
      {running && playbook && <RunNowModal playbook={playbook} onClose={() => setRunning(false)} />}
    </div>
  );
}

export function PlaybookEditorScreen({ id }: { id: string }) {
  return (
    <Suspense fallback={<SkeletonBlock lines={6} />}>
      <EditorView id={id} />
    </Suspense>
  );
}
