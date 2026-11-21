'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, ErrorNote, Field, Modal, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { actionLabel } from '../text';
import type { Rights, Run, RunStep } from '../types';
import { usePbText } from './common';

/** Approve or reject one step that waits for an administrator. What the server allows comes from `rights`. */
export function DecisionButtons({ runId, step, rights, onDone }: { runId: string; step: RunStep; rights: Rights; onDone: () => void }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  if (!rights.can_approve && !rights.can_reject) return <p className="text-xs text-muted">{rights.reason ?? tx.onlyAdminDecides}</p>;

  const submit = async () => {
    if (!mode) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/playbook-runs/${runId}/steps/${step.id}/decision`, { method: 'POST', body: { decision: mode, ...(comment.trim() ? { comment: comment.trim() } : {}) } });
      setMode(null);
      setComment('');
      onDone();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const rejectTooShort = mode === 'reject' && comment.trim().length < 3;
  return (
    <div className="space-y-2">
      {rights.reason && <p className="text-xs text-muted">{rights.reason}</p>}
      <div className="flex flex-wrap gap-2">
        {rights.can_approve && (
          <Button size="sm" variant="primary" onClick={() => setMode('approve')}>
            {tx.approve}
          </Button>
        )}
        {rights.can_reject && (
          <Button size="sm" onClick={() => setMode('reject')}>
            {tx.reject}
          </Button>
        )}
      </div>
      {mode && (
        <Modal title={mode === 'approve' ? tx.approve : tx.reject} onClose={() => (busy ? undefined : setMode(null))}>
          <div className="space-y-3">
            <p className="text-[13px]">
              <span className="font-medium">{actionLabel(step.action, locale)}</span>
            </p>
            {mode === 'approve' && rights.self_approval === 'only_administrator' && <p className="text-xs text-warn">{tx.selfApprovalNote}</p>}
            <Field label={mode === 'reject' ? tx.rejectReason : tx.comment}>
              {(id) => <Textarea id={id} dir="auto" maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />}
            </Field>
            {error && <ErrorNote error={error} />}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setMode(null)} disabled={busy}>
                {tx.cancel}
              </Button>
              <Button variant={mode === 'approve' ? 'primary' : 'danger'} busy={busy} disabled={rejectTooShort} onClick={() => void submit()}>
                {mode === 'approve' ? tx.approve : tx.reject}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** A pending approval in the approvals list: which playbook, which step, what it acts on, and the decision. */
export function ApprovalCard({ run, step, stepsTotal, rights, onDone }: { run: Run; step: RunStep; stepsTotal: number; rights: Rights; onDone: () => void }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const gate = step.action === 'approval' ? (typeof step.params.message === 'string' ? step.params.message : '') : '';
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px]">
            <Link href={`/mind/playbooks/runs/${run.id}`} className="font-medium text-fg hover:underline" dir="auto">
              {run.playbook_name}
            </Link>{' '}
            <span className="text-muted">{tx.wantsTo}</span> <span className="font-medium">{actionLabel(step.action, locale)}</span>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {fill(tx.stepN, { n: step.position + 1 })} / {stepsTotal}
            {step.approval_requested_at ? ` · ${relativeTime(step.approval_requested_at, locale)}` : ''}
            {step.approval_expires_at ? ` · ${fill(tx.expiresAt, { when: relativeTime(step.approval_expires_at, locale) })}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {run.dry_run && <Badge tone="info">{tx.dryRunBadge}</Badge>}
          <Badge tone={step.risk === 'disruptive' ? 'warn' : 'idle'}>{step.risk === 'disruptive' ? tx.disruptive : tx.lowRisk}</Badge>
        </div>
      </div>
      {gate && (
        <p className="text-[13px]" dir="auto">
          {gate}
        </p>
      )}
      {step.input && Object.keys(step.input).length > 0 && (
        <pre className="mono max-h-40 overflow-auto rounded-[var(--radius-control)] bg-raised px-2.5 py-1.5 text-xs" dir="ltr">
          {JSON.stringify(step.input, null, 2)}
        </pre>
      )}
      <DecisionButtons runId={run.id} step={step} rights={rights} onDone={onDone} />
    </li>
  );
}
