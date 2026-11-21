'use client';

import { CheckCircle2, GitBranch, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Async, BUTTON_BASE, BUTTON_SIZE, BUTTON_VARIANT, Badge, Button, Card, DataTable, EmptyState, ErrorNote, PageHeader, Switch, Tabs } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { type Query, useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { ApprovalCard } from '../components/approval-card';
import { RunStatusBadge, usePbText } from '../components/common';
import { SettingsCard } from '../components/settings-card';
import { TEMPLATE_TEXT, actionLabel } from '../text';
import type { Approval, Catalog, Playbook, Template } from '../types';
import { RunsTable } from './runs-screen';

type Tab = 'playbooks' | 'approvals' | 'runs' | 'templates';

function EnabledSwitch({ playbook, onChanged }: { playbook: Playbook; onChanged: () => void }) {
  const tx = usePbText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const toggle = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/playbooks/${playbook.id}`, { method: 'PATCH', body: { enabled: next } });
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <Switch checked={playbook.enabled} disabled={busy} onChange={(v) => void toggle(v)} label={playbook.enabled ? tx.enabled : tx.disabled} />
      {error && (
        <p className="text-xs text-crit">
          {tx.enableFailed} {error.message}
        </p>
      )}
    </div>
  );
}

function PlaybookList({ items, onChanged, onTemplates }: { items: Playbook[]; onChanged: () => void; onTemplates: () => void }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const { can } = useApp();
  const admin = can('admin');
  if (!items.length)
    return (
      <EmptyState
        icon={<GitBranch />}
        title={tx.emptyTitle}
        action={
          <Button variant="primary" onClick={onTemplates}>
            {tx.browseTemplates}
          </Button>
        }
      >
        <p>{tx.emptyBody}</p>
        {!admin && <p className="mt-1">{tx.onlyAdmins}</p>}
      </EmptyState>
    );
  return (
    <DataTable stack minWidth={820}>
      <thead>
        <tr>
          <th>{tx.name}</th>
          <th>{tx.trigger}</th>
          <th>{tx.steps}</th>
          <th>{tx.status}</th>
          <th>{tx.lastRun}</th>
          <th>{tx.enabledLabel}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((p) => (
          <tr key={p.id}>
            <td data-label={tx.name}>
              <Link href={`/mind/playbooks/${p.id}`} className="font-medium text-fg hover:underline" dir="auto">
                {p.name}
              </Link>
              <p className="mt-0.5 text-xs text-muted">{p.site_name ?? tx.allSites}</p>
            </td>
            <td data-label={tx.trigger} className="text-xs text-muted">
              {tx.triggerKind[p.trigger.kind]}
              {p.next_run_at && <span className="block">{`${tx.nextRun}: ${relativeTime(p.next_run_at, locale)}`}</span>}
            </td>
            <td data-label={tx.steps} className="text-xs">
              {p.steps.map((s) => actionLabel(s.action, locale)).join(' → ')}
            </td>
            <td data-label={tx.status}>
              <span className="inline-flex flex-wrap gap-1.5">
                {p.dry_run && <Badge tone="info">{tx.dryRunBadge}</Badge>}
                {p.approval_mode === 'run_automatically' && <Badge tone="warn">{tx.autoBadge}</Badge>}
                {(p.awaiting_approval ?? 0) > 0 && <Badge tone="warn">{fill(tx.awaitingCount, { n: p.awaiting_approval ?? 0 })}</Badge>}
                {(p.active_runs ?? 0) > 0 && <Badge tone="info">{fill(tx.activeCount, { n: p.active_runs ?? 0 })}</Badge>}
              </span>
            </td>
            <td data-label={tx.lastRun} className="text-xs text-muted">
              {p.last_run_status ? (
                <span className="inline-flex items-center gap-1.5">
                  <RunStatusBadge status={p.last_run_status} />
                  {relativeTime(p.last_run_at, locale)}
                </span>
              ) : (
                tx.never
              )}
            </td>
            <td data-label={tx.enabledLabel}>{admin ? <EnabledSwitch playbook={p} onChanged={onChanged} /> : <Badge tone={p.enabled ? 'ok' : 'idle'}>{p.enabled ? tx.enabled : tx.disabled}</Badge>}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function TemplateCard({ template }: { template: Template }) {
  const tx = usePbText();
  const { locale } = useI18n();
  const { can, siteId } = useApp();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ar = locale === 'ar' ? TEMPLATE_TEXT[template.key]?.ar : undefined;
  const use = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api<Playbook>('/playbooks/from-template', { method: 'POST', body: { template: template.key, site_id: siteId ?? null } });
      router.push(`/mind/playbooks/${p.id}?created=1`);
    } catch (e) {
      setError(e as ApiError);
      setBusy(false);
    }
  };
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium">{ar?.name ?? template.name}</p>
          <p className="mt-0.5 text-xs text-muted">{ar?.description ?? template.description}</p>
        </div>
        {can('admin') && (
          <Button size="sm" variant="primary" busy={busy} onClick={() => void use()}>
            {tx.useTemplate}
          </Button>
        )}
      </div>
      <p className="text-xs">
        <span className="text-muted">{tx.trigger}: </span>
        {tx.triggerKind[template.trigger.kind]}
      </p>
      <ol className="list-decimal space-y-0.5 ps-5 text-xs">
        {template.steps.map((s, i) => (
          <li key={i}>{actionLabel(s.action, locale)}</li>
        ))}
      </ol>
      {error && <ErrorNote error={error} />}
    </li>
  );
}

function Templates() {
  const tx = usePbText();
  const { can } = useApp();
  const query = useQuery<Catalog>('/playbooks/catalog', [], 0);
  return (
    <Card title={tx.tabs.templates} description={can('admin') ? tx.templateCreated : tx.onlyAdmins} padded={false}>
      <Async query={query}>
        {(c) =>
          c.templates.length ? (
            <ul className="divide-y divide-line">
              {c.templates.map((t) => (
                <TemplateCard key={t.key} template={t} />
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-center text-[13px] text-muted">{tx.noTemplates}</p>
          )
        }
      </Async>
    </Card>
  );
}

function Approvals({ query }: { query: Query<{ items: Approval[]; approvers: number }> }) {
  const tx = usePbText();
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <Card title={tx.tabs.approvals} padded={false}>
        <Async query={query}>
          {({ items }) =>
            items.length ? (
              <ul className="divide-y divide-line">
                {items.map((a) => (
                  <ApprovalCard key={a.step.id} run={a.run} step={a.step} stepsTotal={a.steps_total} rights={a.rights} onDone={query.reload} />
                ))}
              </ul>
            ) : (
              <EmptyState icon={<CheckCircle2 />} title={tx.noApprovals} />
            )
          }
        </Async>
      </Card>
      <SettingsCard />
    </div>
  );
}

export function PlaybooksScreen() {
  const tx = usePbText();
  const { can, siteId } = useApp();
  const [tab, setTab] = useState<Tab>('playbooks');
  const playbooks = useQuery<{ items: Playbook[] }>(`/playbooks${qs({ site_id: siteId })}`, ['events'], 30_000);
  const approvals = useQuery<{ items: Approval[]; approvers: number }>('/playbook-approvals?page_size=100', ['events'], 15_000);
  return (
    <div className="space-y-5">
      <PageHeader
        title={tx.pageTitle}
        description={tx.subtitle}
        icon={<GitBranch />}
        actions={
          can('admin') ? (
            <Link href="/mind/playbooks/new" className={`${BUTTON_BASE} ${BUTTON_SIZE.md} ${BUTTON_VARIANT.primary}`}>
              <Plus className="size-4" aria-hidden />
              {tx.newPlaybook}
            </Link>
          ) : undefined
        }
      />
      {!can('admin') && <p className="text-xs text-muted">{can('technician') ? tx.onlyAdminsTech : tx.onlyAdmins}</p>}
      <div>
        <Tabs
          label={tx.pageTitle}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'playbooks', label: tx.tabs.playbooks, count: playbooks.data?.items.length },
            { value: 'approvals', label: tx.tabs.approvals, count: approvals.data?.items.length },
            { value: 'runs', label: tx.tabs.runs },
            { value: 'templates', label: tx.tabs.templates },
          ]}
        />
        {tab === 'playbooks' && (
          <Card padded={false}>
            <Async query={playbooks}>{({ items }) => <PlaybookList items={items} onChanged={playbooks.reload} onTemplates={() => setTab('templates')} />}</Async>
          </Card>
        )}
        {tab === 'approvals' && <Approvals query={approvals} />}
        {tab === 'runs' && (
          <Card
            padded={false}
            action={
              <Link href="/mind/playbooks/runs" className="text-[13px] text-accent-hover hover:underline">
                {tx.allRuns}
              </Link>
            }
            title={tx.tabs.runs}
          >
            <RunsTable pageSize={10} paged={false} />
          </Card>
        )}
        {tab === 'templates' && <Templates />}
      </div>
    </div>
  );
}
