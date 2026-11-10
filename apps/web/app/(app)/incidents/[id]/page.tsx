'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { use, useState } from 'react';
import type { IncidentDetail, Member } from '@lan-detective/shared-types';
import { DiagnosisView, IncidentStatusBadge } from '@/components/diagnosis';
import { Async, Badge, Button, Card, EmptyState, ErrorNote, Evidence, Fact, Field, Modal, PageHeader, Select, Tag, Textarea, severityTone } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { EVENT_TYPE_LABEL, absoluteTime, clockTime, duration, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

const PHASE_STYLE = { before: 'border-line-strong', during: 'border-crit/60', after: 'border-ok/60' } as const;

/** Before / during / after, in chronological order — what led up to the incident and what followed. */
function Replay({ incident }: { incident: IncidentDetail }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  if (!incident.timeline.length) return <EmptyState title={t('incident.noTimeline')} />;
  let lastPhase = '';
  return (
    <ol className="px-4 py-3">
      {incident.timeline.map((e) => {
        const heading = e.phase !== lastPhase;
        lastPhase = e.phase;
        return (
          <li key={e.id}>
            {heading && <p className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wider text-faint first:mt-0">{t(`incident.phase.${e.phase}` as Key)}</p>}
            <div className={`border-s-2 ps-3 ${PHASE_STYLE[e.phase]}`}>
              <button type="button" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-start gap-3 rounded py-1.5 text-start hover:bg-raised/60">
                <span className="mono w-28 shrink-0 pt-0.5 text-xs text-muted" title={absoluteTime(e.occurred_at, locale)}>
                  {clockTime(e.occurred_at, locale, true)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] leading-snug ${e.linked ? 'font-medium text-fg' : 'text-muted'}`} dir="auto">
                    {e.title}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-faint">
                    {EVENT_TYPE_LABEL[e.type]?.[locale] ?? e.type}
                    {e.linked && <Tag>{t('incident.linked')}</Tag>}
                  </span>
                </span>
                <Badge tone={severityTone(e.severity)} dot={false}>
                  {t(`severity.${e.severity}`)}
                </Badge>
              </button>
              {open === e.id && (
                <div className="mb-2 rounded-md border border-line bg-bg/60 p-3">
                  <Evidence details={e.details} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Actions({ incident, reload }: { incident: IncidentDetail; reload: () => void }) {
  const { t } = useI18n();
  const { can } = useApp();
  const members = useQuery<{ items: Member[] }>('/members', [], 300_000);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [fixNote, setFixNote] = useState(incident.resolution_kind === 'manual' ? (incident.resolution_note ?? '') : '');
  const resolved = incident.status === 'resolved';

  const act = async (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      after?.();
      reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  if (!can('technician')) return <p className="text-[13px] text-muted">{t('common.readOnly')}</p>;
  return (
    <div className="space-y-4">
      <ErrorNote error={error} />
      {!resolved && (
        <div className="flex flex-wrap gap-2">
          {incident.status === 'open' && (
            <Button busy={busy === 'ack'} onClick={() => void act('ack', () => api(`/incidents/${incident.id}/acknowledge`, { method: 'POST' }))}>
              {t('incident.acknowledge')}
            </Button>
          )}
          <Button variant="primary" onClick={() => setResolving(true)}>
            {t('incident.resolve')}
          </Button>
          <Button variant="ghost" busy={busy === 'dx'} onClick={() => void act('dx', () => api(`/incidents/${incident.id}/diagnose`, { method: 'POST' }))}>
            {t('incident.rerun')}
          </Button>
        </div>
      )}
      <Field label={t('incident.assignee')}>
        {(id) => (
          <Select id={id} value={incident.assigned_to ?? ''} disabled={busy === 'assign'} onChange={(e) => void act('assign', () => api(`/incidents/${incident.id}`, { method: 'PATCH', body: { assigned_to: e.target.value || null } }))}>
            <option value="">{t('incident.unassigned')}</option>
            {(members.data?.items ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.display_name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {resolved && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act('note', () => api(`/incidents/${incident.id}`, { method: 'PATCH', body: { resolution_note: fixNote } }));
          }}
        >
          <Field label={t('incident.resolveNote')} hint={t('incident.resolveNoteHint')}>
            {(id) => <Textarea id={id} value={fixNote} onChange={(e) => setFixNote(e.target.value)} rows={2} maxLength={2000} />}
          </Field>
          <Button type="submit" size="sm" busy={busy === 'note'} disabled={fixNote.trim().length < 3}>
            {t('incident.editNote')}
          </Button>
        </form>
      )}
      <form
        className="space-y-2 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void act('comment', () => api(`/incidents/${incident.id}/comments`, { method: 'POST', body: { body: comment } }), () => setComment(''));
        }}
      >
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('incident.commentPlaceholder')} aria-label={t('incident.addComment')} rows={2} maxLength={4000} />
        <Button type="submit" size="sm" busy={busy === 'comment'} disabled={!comment.trim()}>
          {t('incident.addComment')}
        </Button>
      </form>
      {resolving && (
        <Modal title={t('incident.resolveTitle')} onClose={() => setResolving(false)}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void act('resolve', () => api(`/incidents/${incident.id}/resolve`, { method: 'POST', body: { note } }), () => setResolving(false));
            }}
          >
            <Field label={t('incident.resolveNote')} hint={t('incident.resolveNoteHint')}>
              {(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} autoFocus />}
            </Field>
            <ErrorNote error={error} />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setResolving(false)}>{t('common.cancel')}</Button>
              <Button type="submit" variant="primary" busy={busy === 'resolve'} disabled={note.trim().length < 3}>
                {t('incident.resolve')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { t, locale } = useI18n();
  const query = useQuery<IncidentDetail>(`/incidents/${id}`, ['events', 'checks', 'collectors', 'devices']);

  return (
    <>
      <Link href="/incidents" className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {t('incident.back')}
      </Link>
      <Async query={query}>
        {(inc) => (
          <>
            <PageHeader
              title={inc.title}
              description={`INC-${inc.number} · ${t(`incident.kind.${inc.kind}` as Key)}${inc.site_name ? ` · ${inc.site_name}` : ''}`}
              actions={
                <>
                  <Badge tone={severityTone(inc.severity)} dot={false}>
                    {t(`severity.${inc.severity}`)}
                  </Badge>
                  <IncidentStatusBadge incident={inc} />
                </>
              }
            />
            <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
              <div className="space-y-4">
                <Card title={t('dx.title')}>{inc.diagnosis ? <DiagnosisView diagnosis={inc.diagnosis} /> : <p className="text-[13px] text-muted">{t('dx.none')}</p>}</Card>
                <Card title={t('incident.replay')} padded={false}>
                  <p className="border-b border-line px-4 py-2.5 text-xs leading-relaxed text-muted">{t('incident.replayHint')}</p>
                  <Replay incident={inc} />
                </Card>
              </div>
              <div className="space-y-4">
                <Card>
                  <dl>
                    <Fact label={t('incident.opened')}>
                      {absoluteTime(inc.opened_at, locale)} <span className="text-muted">· {relativeTime(inc.opened_at, locale)}</span>
                    </Fact>
                    <Fact label={t('incident.duration')}>
                      <span className="tnum">{duration(inc.opened_at, inc.resolved_at)}</span>
                      {!inc.resolved_at && <span className="text-muted"> · {t('incident.ongoing')}</span>}
                    </Fact>
                    {inc.diagnosis && (
                      <Fact label={t('dx.affected')}>
                        <span className="tnum">
                          {inc.diagnosis.affected.devices_offline}/{inc.diagnosis.affected.devices_total} {t('dx.devicesOffline')}
                        </span>
                        {inc.diagnosis.affected.checks.map((c) => (
                          <span key={c.id} className="block text-xs text-muted" dir="auto">
                            {c.name} — {t(`state.${c.state}` as Key)}
                          </span>
                        ))}
                      </Fact>
                    )}
                    {inc.resolved_at && (
                      <Fact label={t('incident.resolution')} source={t(inc.resolution_kind === 'manual' ? 'incident.resolution.manual' : 'incident.resolution.auto')}>
                        <span dir="auto">{inc.resolution_note ?? '—'}</span>
                        <span className="block text-xs text-muted">{absoluteTime(inc.resolved_at, locale)}</span>
                      </Fact>
                    )}
                    {inc.device_id && (
                      <Fact label={t('nav.devices')}>
                        <Link href={`/devices/${inc.device_id}`} className="text-accent-hover hover:underline">
                          {t('topo.openDevice')} →
                        </Link>
                      </Fact>
                    )}
                  </dl>
                </Card>
                <Card title={t('device.manage')}>
                  <Actions incident={inc} reload={query.reload} />
                </Card>
                <Card title={t('incident.activity')} padded={false}>
                  <ul className="divide-y divide-line">
                    {inc.activity.map((a) => (
                      <li key={a.id} className="px-4 py-2.5">
                        <p className={`text-[13px] leading-relaxed ${a.kind === 'comment' ? 'text-fg' : 'text-muted'}`} dir="auto">
                          {a.body}
                        </p>
                        <p className="mt-0.5 text-[11px] text-faint">
                          {a.user_name ?? 'LAN Detective'} · <span title={absoluteTime(a.created_at, locale)}>{relativeTime(a.created_at, locale)}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              </div>
            </div>
          </>
        )}
      </Async>
    </>
  );
}
