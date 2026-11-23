'use client';

import { useEffect, useState } from 'react';
import type { IncidentDetail, Member } from '@nigafiy/shared-types';
import { Button, ErrorNote, Field, Modal, Select, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';

export function Actions({ incident, reload }: { incident: IncidentDetail; reload: () => void }) {
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

  useEffect(() => {
    setFixNote(incident.resolution_kind === 'manual' ? (incident.resolution_note ?? '') : '');
  }, [incident.resolution_kind, incident.resolution_note]);

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
          <Button
            variant="primary"
            onClick={() => {
              // Start from the diagnosis title (editable) so closing an incident is one click when the diagnosis was right.
              if (!note.trim() && incident.diagnosis?.title) setNote(incident.diagnosis.title.slice(0, 2000));
              setResolving(true);
            }}
          >
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
            <Field
              label={t('incident.resolveNote')}
              hint={incident.diagnosis && note === incident.diagnosis.title.slice(0, 2000) ? t('incident.resolveNotePrefilled') : t('incident.resolveNoteHint')}
            >
              {(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} autoFocus dir="auto" />}
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
