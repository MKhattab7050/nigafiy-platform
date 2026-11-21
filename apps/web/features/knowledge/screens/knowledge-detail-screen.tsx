'use client';

import { ArrowLeft, Pencil, ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { KnowledgeDetail } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, ConfidenceBadge, ErrorNote, Fact, Modal, PageHeader, SectionLabel, Tag } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { EVENT_TYPE_LABEL, absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { EntryForm } from '../components/entry-form';
import { EntryStats, KnowledgeStatusBadge, SourceLabel } from '../components/entry-meta';
import { MarkdownView } from '../components/markdown-view';

const fmtDuration = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

export function KnowledgeDetailScreen({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const router = useRouter();
  const query = useQuery<KnowledgeDetail>(`/knowledge/${id}`, ['events']);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  async function act(name: string, run: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await run();
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <Link href="/knowledge" className="mb-4 inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted hover:text-fg">
        <ArrowLeft className="size-3.5 rtl:-scale-x-100" aria-hidden />
        {t('kb.back')}
      </Link>
      <Async query={query}>
        {(e) => {
          const tech = can('technician');
          const admin = can('admin');
          const canEdit = e.status !== 'discarded' && (e.status === 'published' ? admin : tech);
          const post = (name: string) => () => act(name, () => api(`/knowledge/${e.id}/${name}`, { method: 'POST' }));
          const hints: [Key, string[]][] = [
            ['kb.rules', e.rule_ids],
            ['kb.incidentKinds', e.incident_kinds.map((k) => t(`incident.kind.${k}` as Key))],
            ['kb.eventTypes', e.event_types.map((x) => EVENT_TYPE_LABEL[x]?.[locale] ?? x)],
            ['kb.deviceTypes', e.device_types],
            ['kb.vendors', e.vendors],
            ['kb.tags', e.tags],
          ];
          return (
            <>
              <PageHeader
                title={e.title}
                description={`${t(e.kind === 'runbook' ? 'kb.kind.runbook' : 'kb.kind.article')} · ${fill(t('kb.revision'), { n: e.revision })}`}
                actions={
                  <>
                    <KnowledgeStatusBadge status={e.status} />
                    {canEdit && !editing && (
                      <Button size="sm" onClick={() => setEditing(true)}>
                        <Pencil className="size-3.5" aria-hidden />
                        {t('common.edit')}
                      </Button>
                    )}
                    {admin && (e.status === 'candidate' || e.status === 'draft') && (
                      <Button size="sm" variant="primary" busy={busy === 'publish'} disabled={!e.fix_steps.trim()} title={!e.fix_steps.trim() ? t('kb.publishNeedsFix') : undefined} onClick={post('publish')}>
                        {t('kb.publish')}
                      </Button>
                    )}
                    {admin && e.status === 'published' && (
                      <Button size="sm" busy={busy === 'unpublish'} onClick={post('unpublish')}>
                        {t('kb.unpublish')}
                      </Button>
                    )}
                    {tech && (e.status === 'candidate' || e.status === 'draft') && (
                      <Button size="sm" variant="ghost" busy={busy === 'discard'} onClick={post('discard')}>
                        {t('kb.discard')}
                      </Button>
                    )}
                    {tech && e.status === 'discarded' && (
                      <Button size="sm" busy={busy === 'restore'} onClick={post('restore')}>
                        {t('kb.restore')}
                      </Button>
                    )}
                    {admin && (
                      <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                        <Trash2 className="size-3.5" aria-hidden />
                        {t('common.delete')}
                      </Button>
                    )}
                  </>
                }
              />
              {error && (
                <div className="mb-4">
                  <ErrorNote error={error} />
                </div>
              )}
              {!admin && tech && e.status !== 'published' && e.status !== 'discarded' && <p className="mb-4 text-xs text-muted">{t('kb.adminPublishes')}</p>}
              <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                <div className="min-w-0 space-y-5">
                  {editing ? (
                    <Card title={t('common.edit')}>
                      <EntryForm
                        entry={e}
                        onCancel={() => setEditing(false)}
                        onSaved={() => {
                          setEditing(false);
                          query.reload();
                        }}
                      />
                    </Card>
                  ) : (
                    <>
                      <Card title={t('kb.symptoms')}>
                        <MarkdownView source={e.symptoms} empty={t('kb.noText')} />
                      </Card>
                      <Card
                        title={t('kb.cause')}
                        action={
                          e.cause_source === 'doctor' &&
                          e.cause.trim() &&
                          canEdit && (
                            <Button
                              size="sm"
                              busy={busy === 'confirm'}
                              onClick={() => act('confirm', () => api(`/knowledge/${e.id}`, { method: 'PATCH', body: { expected_revision: e.revision, confirm_cause: true } }))}
                            >
                              {t('kb.causeConfirm')}
                            </Button>
                          )
                        }
                      >
                        {e.cause_source === 'doctor' && e.cause.trim() && (
                          <div className="mb-2 flex flex-wrap items-center gap-1.5">
                            <Badge tone="info" dot={false}>
                              {t('kb.causeInferred')}
                            </Badge>
                            {e.diagnosis_confidence && <ConfidenceBadge confidence={e.diagnosis_confidence} />}
                          </div>
                        )}
                        <MarkdownView source={e.cause} empty={t('kb.noText')} />
                      </Card>
                      <Card title={t('kb.fix')}>
                        <MarkdownView source={e.fix_steps} empty={t('kb.noText')} />
                      </Card>
                    </>
                  )}
                  <Card title={t('kb.history')} padded={false}>
                    <ul className="divide-y divide-line">
                      {e.revisions.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2 text-[13px]">
                          <span>
                            {t(`kb.action.${r.action}` as Key)}
                            {r.user_name && <span className="text-muted"> · {fill(t('kb.by'), { name: r.user_name })}</span>}
                          </span>
                          <span className="text-xs text-faint" title={absoluteTime(r.created_at, locale)}>
                            {fill(t('kb.revision'), { n: r.revision })} · {relativeTime(r.created_at, locale)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </div>
                <div className="min-w-0 space-y-5">
                  <Card>
                    <dl>
                      <Fact label={t('common.source')}>
                        <SourceLabel entry={e} />
                      </Fact>
                      {e.incident_id && (
                        <Fact label={t('kb.incident')}>
                          <Link href={`/incidents/${e.incident_id}`} className="text-accent-hover hover:underline">
                            INC-{e.incident_number}
                          </Link>
                          {e.incident_duration_seconds !== null && (
                            <span className="block text-xs text-muted">
                              {t('kb.duration')} {fmtDuration(e.incident_duration_seconds)}
                            </span>
                          )}
                        </Fact>
                      )}
                      {e.diagnosis_summary && (
                        <Fact label={t('kb.diagnosis')} source={t('dx.engine')}>
                          <span dir="auto">{e.diagnosis_summary}</span>
                        </Fact>
                      )}
                      {e.device_id && (
                        <Fact label={t('kb.device')}>
                          <Link href={`/devices/${e.device_id}`} className="text-accent-hover hover:underline" dir="auto">
                            {e.device_name ?? e.device_id}
                          </Link>
                        </Fact>
                      )}
                      {e.site_name && <Fact label={t('kb.site')}>{e.site_name}</Fact>}
                      {e.check_name && <Fact label={t('kb.check')}>{e.check_name}</Fact>}
                      <Fact label={t('kb.updated')}>
                        {relativeTime(e.updated_at, locale)}
                        {e.updated_by_name && <span className="text-muted"> · {e.updated_by_name}</span>}
                      </Fact>
                      {e.published_at && (
                        <Fact label={t('kb.statusOne.published')}>
                          {absoluteTime(e.published_at, locale)}
                          {e.published_by_name && <span className="text-muted"> · {e.published_by_name}</span>}
                        </Fact>
                      )}
                    </dl>
                  </Card>
                  {e.status === 'published' && (
                    <Card title={t('kb.didHelp')} action={<EntryStats entry={e} />}>
                      {tech ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="sm" variant={e.my_vote === true ? 'primary' : 'secondary'} aria-pressed={e.my_vote === true} busy={busy === 'up'} onClick={() => act('up', () => api(`/knowledge/${e.id}/vote`, { method: 'PUT', body: { helpful: true } }))}>
                            <ThumbsUp className="size-3.5" aria-hidden />
                            {t('kb.yes')}
                          </Button>
                          <Button size="sm" variant={e.my_vote === false ? 'primary' : 'secondary'} aria-pressed={e.my_vote === false} busy={busy === 'down'} onClick={() => act('down', () => api(`/knowledge/${e.id}/vote`, { method: 'PUT', body: { helpful: false } }))}>
                            <ThumbsDown className="size-3.5" aria-hidden />
                            {t('kb.no')}
                          </Button>
                          {e.my_vote !== null && (
                            <Button size="sm" variant="ghost" busy={busy === 'clear'} onClick={() => act('clear', () => api(`/knowledge/${e.id}/vote`, { method: 'DELETE' }))}>
                              {t('kb.clearVote')}
                            </Button>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-muted">{t('common.readOnly')}</p>
                      )}
                    </Card>
                  )}
                  <Card title={t('kb.usedOn')} padded={false}>
                    {e.used_on.length === 0 ? (
                      <p className="px-4 py-3 text-[13px] text-muted">{t('kb.usedNone')}</p>
                    ) : (
                      <ul className="divide-y divide-line">
                        {e.used_on.map((u) => (
                          <li key={u.incident_id} className="flex items-center justify-between gap-2 px-4 py-2 text-[13px]">
                            <span className="min-w-0">
                              <Link href={`/incidents/${u.incident_id}`} className="text-accent-hover hover:underline">
                                INC-{u.incident_number}
                              </Link>{' '}
                              <span dir="auto">{u.incident_title}</span>
                              <span className="block text-[11px] text-faint">
                                {u.user_name} · {relativeTime(u.created_at, locale)}
                              </span>
                            </span>
                            {tech && (
                              <Button size="sm" variant="ghost" busy={busy === `unlink:${u.incident_id}`} onClick={() => act(`unlink:${u.incident_id}`, () => api(`/knowledge/${e.id}/uses/${u.incident_id}`, { method: 'DELETE' }))}>
                                {t('kb.unlink')}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  {hints.some(([, v]) => v.length > 0) && (
                    <Card title={t('kb.matching')}>
                      <div className="space-y-3">
                        {hints
                          .filter(([, v]) => v.length > 0)
                          .map(([label, values]) => (
                            <div key={label}>
                              <SectionLabel>{t(label)}</SectionLabel>
                              <div className="flex flex-wrap gap-1.5">
                                {values.map((v) => (
                                  <Tag key={v}>{v}</Tag>
                                ))}
                              </div>
                            </div>
                          ))}
                      </div>
                    </Card>
                  )}
                </div>
              </div>
              {confirmDelete && (
                <Modal title={t('common.delete')} onClose={() => setConfirmDelete(false)}>
                  <p className="text-[13px]">{t('kb.deleteConfirm')}</p>
                  <p className="mt-1 text-[13px] font-medium" dir="auto">
                    {e.title}
                  </p>
                  <div className="mt-4 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                      {t('common.cancel')}
                    </Button>
                    <Button
                      variant="danger"
                      busy={busy === 'delete'}
                      onClick={async () => {
                        setBusy('delete');
                        setError(null);
                        try {
                          await api(`/knowledge/${e.id}`, { method: 'DELETE' });
                          router.push('/knowledge');
                        } catch (err) {
                          setError(err as ApiError);
                          setConfirmDelete(false);
                          setBusy('');
                        }
                      }}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                </Modal>
              )}
            </>
          );
        }}
      </Async>
    </>
  );
}
