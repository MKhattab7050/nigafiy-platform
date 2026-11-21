'use client';

import { BookOpen, Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { KnowledgeKind, KnowledgeList, KnowledgeStatus } from '@lan-detective/shared-types';
import { markdownToText } from '@lan-detective/shared-types/markdown';
import { Async, Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Select, Tabs, Tag } from '@/components/ui';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { EntryForm } from '../components/entry-form';
import { EntryStats, KnowledgeStatusBadge, SourceLabel } from '../components/entry-meta';

type StatusFilter = KnowledgeStatus | 'all';
const PAGE_SIZE = 25;

export function KnowledgeScreen() {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const router = useRouter();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [kind, setKind] = useState<KnowledgeKind | ''>('');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(text.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);

  const list = useQuery<KnowledgeList>(`/knowledge${qs({ q, status, kind, tag, page, page_size: PAGE_SIZE })}`, ['events']);
  const tags = useQuery<{ items: { tag: string; count: number }[] }>('/knowledge/tags', ['events'], 120_000);
  const counts = list.data?.counts;
  const tech = can('technician');

  const statusOptions: { value: StatusFilter; label: string; count?: number }[] = [
    { value: 'all', label: t('kb.status.all') },
    ...(tech ? [{ value: 'candidate' as const, label: t('kb.status.candidate'), count: counts?.candidate }] : []),
    ...(tech ? [{ value: 'draft' as const, label: t('kb.status.draft'), count: counts?.draft }] : []),
    { value: 'published', label: t('kb.status.published'), count: counts?.published },
    ...(tech ? [{ value: 'discarded' as const, label: t('kb.status.discarded'), count: counts?.discarded }] : []),
  ];

  return (
    <>
      <PageHeader
        icon={<BookOpen className="size-[18px]" aria-hidden />}
        title={t('kb.title')}
        description={t('kb.intro')}
        actions={
          tech && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden />
              {t('kb.new')}
            </Button>
          )
        }
      />
      <Tabs
        label={t('kb.title')}
        value={status}
        options={statusOptions}
        onChange={(v) => {
          setStatus(v);
          setPage(1);
        }}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-56 flex-1">
          <span className="sr-only">{t('common.search')}</span>
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('kb.searchPlaceholder')} className="ps-8" dir="auto" maxLength={120} />
        </label>
        <Select
          aria-label={t('kb.kind')}
          className="w-40"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as KnowledgeKind | '');
            setPage(1);
          }}
        >
          <option value="">{t('kb.kind.all')}</option>
          <option value="article">{t('kb.kind.article')}</option>
          <option value="runbook">{t('kb.kind.runbook')}</option>
        </Select>
      </div>
      {tags.data && tags.data.items.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5" aria-label={t('kb.tags')} role="group">
          {tags.data.items.map((x) => (
            <button
              key={x.tag}
              type="button"
              aria-pressed={tag === x.tag}
              onClick={() => {
                setTag(tag === x.tag ? '' : x.tag);
                setPage(1);
              }}
              className={`inline-flex h-6 items-center gap-1 rounded-[5px] border px-2 text-[11.5px] ${tag === x.tag ? 'border-accent bg-accent/10 text-fg' : 'border-line bg-raised text-muted hover:text-fg'}`}
            >
              <span dir="auto">{x.tag}</span>
              <span className="tnum text-faint">{x.count}</span>
            </button>
          ))}
          {tag && (
            <Button size="sm" variant="ghost" onClick={() => setTag('')}>
              <X className="size-3.5" aria-hidden />
              {t('kb.clearTag')}
            </Button>
          )}
        </div>
      )}
      <Async query={list}>
        {(data) => {
          const pages = Math.max(1, Math.ceil(data.total / data.page_size));
          if (!data.items.length)
            return (
              <Card>
                {q || tag || kind || status !== 'all' ? (
                  <EmptyState icon={<Search />} title={t('kb.noMatch')} />
                ) : (
                  <EmptyState icon={<BookOpen />} title={t('kb.empty')}>
                    <p>{t('kb.emptyHint')}</p>
                  </EmptyState>
                )}
              </Card>
            );
          return (
            <Card padded={false}>
              <ul className="divide-y divide-line">
                {data.items.map((e) => {
                  const excerpt = markdownToText(e.fix_steps || e.symptoms).slice(0, 220);
                  return (
                    <li key={e.id}>
                      <Link href={`/mind/knowledge/${e.id}`} className="block px-4 py-3 transition-colors hover:bg-raised">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 text-[13.5px] font-medium text-fg" dir="auto">
                            {e.title}
                          </span>
                          <KnowledgeStatusBadge status={e.status} />
                          <Badge tone="info" dot={false}>
                            {t(e.kind === 'runbook' ? 'kb.kind.runbook' : 'kb.kind.article')}
                          </Badge>
                        </div>
                        {excerpt && (
                          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted" dir="auto">
                            {excerpt}
                          </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-faint">
                          <SourceLabel entry={e} />
                          <span>
                            {t('kb.updated')} {relativeTime(e.updated_at, locale)}
                          </span>
                          {e.status === 'published' && <EntryStats entry={e} />}
                          {e.tags.slice(0, 5).map((x) => (
                            <Tag key={x}>{x}</Tag>
                          ))}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {pages > 1 && (
                <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
                  <span>{fill(t('kb.page'), { page: data.page, pages })}</span>
                  <span className="flex gap-2">
                    <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                      {t('kb.prev')}
                    </Button>
                    <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                      {t('kb.next')}
                    </Button>
                  </span>
                </div>
              )}
            </Card>
          );
        }}
      </Async>
      {creating && (
        <Modal title={t('kb.new')} onClose={() => setCreating(false)} wide>
          <EntryForm
            onCancel={() => setCreating(false)}
            onSaved={(e) => {
              setCreating(false);
              router.push(`/mind/knowledge/${e.id}`);
            }}
          />
        </Modal>
      )}
    </>
  );
}
