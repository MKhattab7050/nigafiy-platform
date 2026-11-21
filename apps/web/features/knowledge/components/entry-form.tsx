'use client';

import { useState } from 'react';
import type { KnowledgeDetail, KnowledgeEntry, KnowledgeKind } from '@lan-detective/shared-types';
import { Button, ErrorNote, Field, Input, Segmented, Switch, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApp } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { MarkdownView } from './markdown-view';

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

interface Draft {
  kind: KnowledgeKind;
  title: string;
  symptoms: string;
  cause: string;
  fix_steps: string;
  tags: string;
  rule_ids: string;
  vendors: string;
}

const fromEntry = (e?: KnowledgeEntry): Draft => ({
  kind: e?.kind ?? 'article',
  title: e?.title ?? '',
  symptoms: e?.symptoms ?? '',
  cause: e?.cause ?? '',
  fix_steps: e?.fix_steps ?? '',
  tags: e?.tags.join(', ') ?? '',
  rule_ids: e?.rule_ids.join(', ') ?? '',
  vendors: e?.vendors.join(', ') ?? '',
});

/**
 * Create (no `entry`) or edit an article. Editing sends only the fields that changed, with the
 * revision the editor started from, so a concurrent save is reported instead of overwritten.
 */
export function EntryForm({ entry, onSaved, onCancel }: { entry?: KnowledgeDetail; onSaved: (e: KnowledgeEntry) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const { can } = useApp();
  const [d, setD] = useState<Draft>(() => fromEntry(entry));
  const [publish, setPublish] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const fieldError = (path: string) => error?.details?.find((x) => x.path === path)?.message;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const full = {
        kind: d.kind,
        title: d.title,
        symptoms: d.symptoms,
        cause: d.cause,
        fix_steps: d.fix_steps,
        tags: splitList(d.tags),
        rule_ids: splitList(d.rule_ids),
        vendors: splitList(d.vendors),
      };
      let saved: KnowledgeEntry;
      if (!entry) {
        saved = await api<KnowledgeEntry>('/knowledge', { method: 'POST', body: { ...full, publish: can('admin') && publish } });
      } else {
        const before = fromEntry(entry);
        const body: Record<string, unknown> = { expected_revision: entry.revision };
        for (const k of Object.keys(before) as (keyof Draft)[]) if (before[k] !== d[k]) body[k] = full[k];
        if (Object.keys(body).length === 1) return onCancel();
        saved = await api<KnowledgeEntry>(`/knowledge/${entry.id}`, { method: 'PATCH', body });
      }
      onSaved(saved);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {error && (error.code === 'stale_revision' ? <ErrorNote error={new ApiError(409, error.code, t('kb.stale'))} /> : <ErrorNote error={error} />)}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label={t('kb.kind')}
          value={d.kind}
          onChange={(v) => set('kind', v)}
          options={[
            { value: 'article', label: t('kb.kind.article') },
            { value: 'runbook', label: t('kb.kind.runbook') },
          ]}
        />
        <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)} aria-pressed={preview}>
          {t('kb.form.preview')}
        </Button>
      </div>
      <Field label={t('kb.form.title')} error={fieldError('title')}>
        {(id) => <Input id={id} value={d.title} onChange={(e) => set('title', e.target.value)} required minLength={3} maxLength={200} dir="auto" />}
      </Field>
      {(['symptoms', 'cause', 'fix_steps'] as const).map((k) =>
        preview ? (
          <div key={k}>
            <p className="mb-1.5 text-xs font-medium text-fg/85">{t(k === 'fix_steps' ? 'kb.form.fix' : k === 'cause' ? 'kb.form.cause' : 'kb.form.symptoms')}</p>
            <div className="rounded-[var(--radius-control)] border border-line bg-sunken px-3 py-2">
              <MarkdownView source={d[k]} empty={t('kb.noText')} />
            </div>
          </div>
        ) : (
          <Field
            key={k}
            label={t(k === 'fix_steps' ? 'kb.form.fix' : k === 'cause' ? 'kb.form.cause' : 'kb.form.symptoms')}
            hint={k === 'fix_steps' ? t('kb.form.fixHint') : k === 'symptoms' ? t('kb.form.symptomsHint') : undefined}
            error={fieldError(k)}
          >
            {(id) => <Textarea id={id} value={d[k]} onChange={(e) => set(k, e.target.value)} rows={k === 'fix_steps' ? 7 : 3} dir="auto" />}
          </Field>
        ),
      )}
      <Field label={t('kb.form.tags')} hint={t('kb.form.tagsHint')} error={fieldError('tags')}>
        {(id) => <Input id={id} value={d.tags} onChange={(e) => set('tags', e.target.value)} dir="auto" />}
      </Field>
      <details className="rounded-[var(--radius-control)] border border-line px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted">{t('common.advanced')}</summary>
        <div className="mt-3 space-y-3">
          <Field label={t('kb.form.rules')} hint={t('kb.form.rulesHint')} error={fieldError('rule_ids')}>
            {(id) => <Input id={id} value={d.rule_ids} onChange={(e) => set('rule_ids', e.target.value)} dir="ltr" className="mono" />}
          </Field>
          <Field label={t('kb.form.vendors')} error={fieldError('vendors')}>
            {(id) => <Input id={id} value={d.vendors} onChange={(e) => set('vendors', e.target.value)} dir="auto" />}
          </Field>
        </div>
      </details>
      {!entry && (
        <div className="flex items-center gap-2 text-[13px]">
          {can('admin') ? (
            <>
              <Switch checked={publish} onChange={setPublish} label={t('kb.form.publishNow')} />
              <span>{t('kb.form.publishNow')}</span>
            </>
          ) : (
            <span className="text-muted">{t('kb.adminPublishes')}</span>
          )}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {entry ? t('common.save') : publish && can('admin') ? t('kb.form.createPublish') : t('kb.form.create')}
        </Button>
      </div>
    </form>
  );
}
