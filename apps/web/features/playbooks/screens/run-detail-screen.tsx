'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorNote, Evidence, Field, Modal, Notice, PageHeader, SkeletonBlock, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { DecisionButtons } from '../components/approval-card';
import { RunStatusBadge, StepStatusBadge, STEP_TONE, usePbText } from '../components/common';
import { actionLabel } from '../text';
import { ACTIVE, type RunDetail, type RunStep } from '../types';

function Json({ value }: { value: Record<string, unknown> }) {
  return (
    <pre className="mono max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-control)] bg-raised px-2.5 py-1.5 text-xs" dir="ltr">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function StepItem({ run, step, total, onChanged }: { run: RunDetail; step: RunStep; total: number; onChanged: () => void }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const output = step.output ?? null;
  const note = output && typeof output.note === 'string' ? output.note : null;
  const selfApproved = output?.self_approved === true;
  const { note: _n, self_approved: _s, self_approval_reason: _r, ...rest } = output ?? {};
  const tone = STEP_TONE[step.status];
  return (
    <li className="relative ps-8">
      <span
        className={`absolute start-0 top-0.5 flex size-6 items-center justify-center rounded-full border text-xs font-semibold tnum ${
          tone === 'ok' ? 'border-ok/50 text-ok' : tone === 'crit' ? 'border-crit/50 text-crit' : tone === 'warn' ? 'border-warn/50 text-warn' : 'border-line-strong text-muted'
        }`}
        aria-hidden
      >
        {step.position + 1}
      </span>
      <div className="space-y-2 rounded-[var(--radius-card)] border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-[13px]">
            <span className="sr-only">{fill(tx.stepN, { n: step.position + 1 })} / {total}: </span>
            <span className="font-medium">{actionLabel(step.action, locale)}</span>{' '}
            <span className="mono text-xs text-faint" dir="ltr">
              {step.step_key}
            </span>
          </p>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {step.risk === 'disruptive' && <Badge tone="warn" dot={false}>{step.needs_approval ? tx.disruptive : tx.autoBadge}</Badge>}
            <StepStatusBadge status={step.status} />
          </span>
        </div>
        <p className="text-xs text-muted">
          {step.started_at ? absoluteTime(step.started_at, locale) : null}
          {step.finished_at ? ` → ${absoluteTime(step.finished_at, locale)}` : null}
          {step.status === 'succeeded' || step.status === 'failed' ? ` · ${step.actor === 'user' && step.actor_email ? fill(tx.ranBy, { who: step.actor_email }) : tx.ranBySystem}` : null}
        </p>
        {step.status === 'awaiting_approval' && (
          <div className="space-y-2 rounded-[var(--radius-control)] border border-warn/40 bg-warn/[0.06] p-2.5">
            <p className="text-[13px] font-medium">{tx.approvalNeeded}</p>
            {step.approval_expires_at && <p className="text-xs text-muted">{fill(tx.expiresAt, { when: relativeTime(step.approval_expires_at, locale) })}</p>}
            {step.action === 'approval' && typeof step.params.message === 'string' && step.params.message && (
              <p className="text-[13px]" dir="auto">
                {step.params.message}
              </p>
            )}
            {step.rights ? <DecisionButtons runId={run.id} step={step} rights={step.rights} onDone={onChanged} /> : <p className="text-xs text-muted">{tx.onlyAdminDecides}</p>}
          </div>
        )}
        {step.status === 'expired' && <p className="text-xs text-warn">{tx.expiredNote}</p>}
        {step.decided_by_email && (
          <p className="text-xs text-muted">
            {fill(step.status === 'rejected' ? tx.rejectedBy : tx.approvedBy, { who: step.decided_by_email })}
            {step.decided_at ? ` · ${relativeTime(step.decided_at, locale)}` : ''}
            {selfApproved ? ` · ${tx.selfApprovedShort}` : ''}
          </p>
        )}
        {selfApproved && <p className="text-xs text-warn">{fill(tx.selfApproved, { who: step.decided_by_email ?? '—' })}</p>}
        {step.decision_comment && (
          <p className="text-xs">
            <span className="text-muted">{tx.decisionComment}: </span>
            <span dir="auto">{step.decision_comment}</span>
          </p>
        )}
        {step.input && Object.keys(step.input).length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted">{tx.input}</p>
            <Json value={step.input} />
          </div>
        )}
        {note && (
          <p className="text-xs text-warn" dir="auto">
            <span className="font-medium">{tx.effectNote}: </span>
            {note}
          </p>
        )}
        {Object.keys(rest).length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted">{tx.output}</p>
            <Json value={rest} />
          </div>
        )}
        {step.error && (
          <p className="text-xs text-crit" dir="auto">
            <span className="font-medium">{tx.error}: </span>
            {step.error}
          </p>
        )}
      </div>
    </li>
  );
}

function CancelButton({ runId, onDone }: { runId: string; onDone: () => void }) {
  const tx = usePbText();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/playbook-runs/${runId}/cancel`, { method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {} });
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        {tx.cancelRun}
      </Button>
      {open && (
        <Modal title={tx.cancelRun} onClose={() => (busy ? undefined : setOpen(false))}>
          <div className="space-y-3">
            <p className="text-[13px]">{tx.cancelConfirm}</p>
            <Field label={tx.cancelReason}>{(id) => <Textarea id={id} dir="auto" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            {error && <ErrorNote error={error} />}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setOpen(false)} disabled={busy}>
                {tx.cancel}
              </Button>
              <Button variant="danger" busy={busy} onClick={() => void submit()}>
                {tx.cancelYes}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function RunDetailScreen({ id }: { id: string }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const [refresh, setRefresh] = useState(5000);
  const query = useQuery<RunDetail>(`/playbook-runs/${id}`, ['events'], refresh);
  const run = query.data;
  const active = run ? ACTIVE.includes(run.status) : true;
  useEffect(() => setRefresh(active ? 5000 : 0), [active]);

  const back = (
    <Link href="/playbooks/runs" className="inline-flex items-center gap-1 text-[13px] text-accent-hover hover:underline">
      <ArrowLeft className="size-3.5 rtl:rotate-180" aria-hidden />
      {tx.backToRuns}
    </Link>
  );

  if (!run) {
    if (query.error)
      return (
        <div className="space-y-5">
          <PageHeader title={tx.runsTitle} actions={back} />
          {query.error.status === 404 ? <EmptyState title={query.error.message} action={back} /> : <ErrorNote error={query.error} onRetry={query.reload} />}
        </div>
      );
    return <SkeletonBlock lines={8} />;
  }

  const evidence = run.evidence ?? {};
  return (
    <div className="space-y-5">
      <PageHeader
        title={run.playbook_name}
        description={`${fill(tx.version, { v: run.playbook_version })} · ${fill(tx.triggeredBy[run.trigger_kind], { who: run.started_by_email ?? '—' })} · ${absoluteTime(run.created_at, locale)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {back}
            {run.playbook_id && (
              <Link href={`/playbooks/${run.playbook_id}`} className="text-[13px] text-accent-hover hover:underline">
                {tx.playbook}
              </Link>
            )}
            {run.can_cancel && <CancelButton runId={run.id} onDone={query.reload} />}
          </div>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusBadge status={run.status} />
        {active && <Badge tone="info" dot={false}>{tx.live}</Badge>}
        {run.site_name && <Badge tone="idle" dot={false}>{run.site_name}</Badge>}
        {run.devices.map((d) => (
          <Link key={d.id} href={`/devices/${d.id}`} className="text-xs text-accent-hover hover:underline" dir="auto">
            {d.label}
          </Link>
        ))}
      </div>
      {query.error && <ErrorNote error={query.error} onRetry={query.reload} />}
      {run.dry_run && <Notice>{tx.dryRunNotice}</Notice>}
      {run.caused_by_run_id && (
        <p className="text-xs text-muted">
          {tx.causedBy}:{' '}
          <Link href={`/playbooks/runs/${run.caused_by_run_id}`} className="mono text-accent-hover hover:underline" dir="ltr">
            {run.caused_by_run_id.slice(0, 8)}
          </Link>
        </p>
      )}
      {run.status_reason && (
        <p className="text-[13px]">
          <span className="text-muted">{tx.statusReason}: </span>
          <span dir="auto">{run.status_reason}</span>
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card title={tx.steps} description={`${run.steps.filter((s) => !['pending', 'awaiting_approval', 'running', 'approved'].includes(s.status)).length} / ${run.steps.length}`}>
          <ol className="space-y-3">
            {run.steps.map((s) => (
              <StepItem key={s.id} run={run} step={s} total={run.steps.length} onChanged={query.reload} />
            ))}
          </ol>
        </Card>
        <Card title={tx.evidence}>{Object.keys(evidence).length ? <Evidence details={evidence} /> : <p className="text-[13px] text-muted">{tx.noEvidence}</p>}</Card>
      </div>
    </div>
  );
}
