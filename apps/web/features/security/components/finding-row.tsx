'use client';

import { useState } from 'react';
import type { Confidence } from '@nigafiy/shared-types';
import { Badge, Button, ConfidenceBadge, ErrorNote, Evidence, Field, InferredBadge, Modal, Textarea, severityTone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { APPROVABLE_KINDS, type Finding } from '../types';
import { DeviceLink } from '@/components/device-link';

const CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];
const confidenceOf = (v: unknown): Confidence | null => (CONFIDENCES.includes(v as Confidence) ? (v as Confidence) : null);

/**
 * How a finding was established, from what the API recorded: `basis` ("observed: …" / "inferred: …")
 * when the check wrote one, otherwise the confidence of the analysis (Wi-Fi). Never upgraded here.
 */
function method(details: Record<string, unknown>): { kind: 'observed' | 'inferred'; text: string | null; confidence: Confidence | null } {
  const confidence = confidenceOf(details.confidence);
  const basis = typeof details.basis === 'string' ? details.basis : null;
  if (basis) {
    const [head, ...rest] = basis.split(':');
    const kind = head?.trim() === 'observed' ? 'observed' : 'inferred';
    return { kind, text: rest.join(':').trim() || basis, confidence };
  }
  return { kind: confidence === 'high' ? 'observed' : 'inferred', text: null, confidence };
}

const HIDDEN_DETAILS = new Set(['basis', 'confidence', 'evidence', 'measured_from', 'collector_id']);

export function FindingRow({ finding: f, onChanged }: { finding: Finding; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [dialog, setDialog] = useState<'resolve' | 'expected' | null>(null);
  const [note, setNote] = useState('');

  const how = method(f.details);
  const evidence = Array.isArray(f.details.evidence) ? (f.details.evidence as unknown[]).map(String) : [];
  const measuredFrom = typeof f.details.measured_from === 'string' ? f.details.measured_from : null;
  const rest = Object.fromEntries(Object.entries(f.details).filter(([k]) => !HIDDEN_DETAILS.has(k)));
  const isOpen = f.status === 'open';

  const act = async (name: string, path: string, body?: unknown) => {
    setBusy(name);
    setError(null);
    try {
      await api(path, { method: 'POST', body });
      setDialog(null);
      setNote('');
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={severityTone(f.severity)}>{t(`security.sev.${f.severity}` as Key)}</Badge>
            <Badge tone="idle" dot={false}>
              {t(`security.f.category.${f.category}` as Key)}
            </Badge>
            {how.kind === 'observed' ? (
              <span className="inline-flex flex-wrap items-center gap-1">
                <Badge tone="ok" dot={false}>
                  {t('common.observed')}
                </Badge>
                {how.confidence && <ConfidenceBadge confidence={how.confidence} />}
              </span>
            ) : (
              <InferredBadge confidence={how.confidence} />
            )}
            {f.status === 'resolved' && <Badge tone="idle">{t('security.f.status.resolved')}</Badge>}
            {isOpen && f.acknowledged_at && <Badge tone="info">{fill(t('security.f.acknowledged'), { when: relativeTime(f.acknowledged_at, locale) })}</Badge>}
          </div>
          {/* Titles quote SSIDs and device names: plain text only. */}
          <p className="break-words text-[13.5px] font-medium text-fg" dir="auto">
            {f.title}
          </p>
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span title={absoluteTime(f.first_seen_at, locale)}>
              {t('security.f.firstSeen')}: {relativeTime(f.first_seen_at, locale)}
            </span>
            <span title={absoluteTime(f.last_seen_at, locale)}>
              {t('security.f.lastSeen')}: {relativeTime(f.last_seen_at, locale)}
            </span>
            {f.device_id && (
              <span>
                {t('security.f.device')}:{' '}
                <DeviceLink id={f.device_id} className="text-accent-hover hover:underline" dir="auto">
                  {f.device_name ?? f.device_id}
                </DeviceLink>
              </span>
            )}
          </p>
          {f.status === 'resolved' && f.resolution && (
            <p className="text-xs text-muted" dir="auto">
              {f.resolved_at ? `${fill(t('security.f.resolvedAt'), { when: relativeTime(f.resolved_at, locale) })} · ` : ''}
              {f.resolution}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {isOpen && can('technician') && !f.acknowledged_at && (
            <Button size="sm" variant="ghost" busy={busy === 'ack'} onClick={() => void act('ack', `/security/findings/${f.id}/acknowledge`)}>
              {t('security.f.acknowledge')}
            </Button>
          )}
          {isOpen && can('technician') && (
            <Button size="sm" onClick={() => (setError(null), setDialog('resolve'))}>
              {t('security.f.resolve')}
            </Button>
          )}
          {isOpen && can('admin') && APPROVABLE_KINDS.includes(f.kind) && (
            <Button size="sm" onClick={() => (setError(null), setDialog('expected'))}>
              {t('security.f.markExpected')}
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? t('security.f.hideDetails') : t('security.f.showDetails')}
          </Button>
        </div>
      </div>
      {error && !dialog && (
        <div className="mt-2">
          <ErrorNote error={error} />
        </div>
      )}
      {open && (
        <div className="mt-3 space-y-3 rounded-[var(--radius-control)] border border-line bg-sunken/50 p-3">
          <div>
            <p className="mb-1 text-xs font-medium text-muted">{t('security.f.how')}</p>
            <p className="text-[13px] text-fg" dir="auto">
              {how.text ?? (how.kind === 'observed' ? t('common.observed') : t('common.inferred'))}
            </p>
            {measuredFrom && (
              <p className="mt-0.5 text-xs text-muted" dir="auto">
                {t('security.f.measuredFrom')}: {measuredFrom}
              </p>
            )}
          </div>
          {evidence.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t('security.f.evidence')}</p>
              <ul className="list-inside list-disc space-y-0.5 text-[13px] text-fg">
                {evidence.map((e, i) => (
                  <li key={i} dir="auto" className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Object.keys(rest).length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t('security.f.details')}</p>
              <Evidence details={rest} />
            </div>
          )}
        </div>
      )}

      {dialog === 'resolve' && (
        <Modal title={t('security.f.resolveTitle')} onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <p className="text-[13px] text-muted">{t('security.f.resolveHint')}</p>
            <Field label={t('security.f.note')}>{(id) => <Textarea id={id} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <ErrorNote error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" busy={busy === 'resolve'} onClick={() => void act('resolve', `/security/findings/${f.id}/resolve`, note.trim() ? { note: note.trim() } : {})}>
                {t('security.f.resolve')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {dialog === 'expected' && (
        <Modal title={t('security.f.expectedTitle')} onClose={() => setDialog(null)}>
          <div className="space-y-3">
            <p className="break-words text-[13px] font-medium text-fg" dir="auto">
              {f.title}
            </p>
            <p className="text-[13px] text-muted">{t(`security.f.expectedHint.${f.kind}` as Key)}</p>
            <Field label={t('security.f.note')}>{(id) => <Textarea id={id} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <ErrorNote error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" busy={busy === 'expected'} onClick={() => void act('expected', `/security/findings/${f.id}/expected`, note.trim() ? { note: note.trim() } : {})}>
                {t('security.f.expectedTitle')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </li>
  );
}
