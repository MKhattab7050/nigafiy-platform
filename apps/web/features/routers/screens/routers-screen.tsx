'use client';

import { Pencil, Plus, RefreshCw, Router, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Collector } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, DataTable, EmptyState, PageHeader, SkeletonBlock } from '@/components/ui';
import { api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';
import { RequestProgress } from '../components/request-progress';
import { DeleteRouterModal, EditRouterModal, RouterWizardModal } from '../components/router-modals';
import { DELIVERY_TONE, HEALTH_TONE, RouterErrorNote, deliveryText } from '../components/text';
import type { QueuedRequest, SiteRouter } from '../types';

export function RoutersScreen() {
  const { t, locale } = useI18n();
  const routerNav = useRouter();
  const { siteId, sites, can } = useApp();
  const activeSite = siteId ?? sites[0]?.id ?? '';
  const routersQuery = useQuery<{ items: SiteRouter[] }>(`/routers${qs({ site_id: siteId })}`, ['devices', 'collectors'], 20_000);
  const collectorsQuery = useQuery<{ items: Collector[] }>(activeSite ? '/collectors' : null, ['collectors']);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<SiteRouter | null>(null);
  const [deleting, setDeleting] = useState<SiteRouter | null>(null);
  const [activeRequests, setActiveRequests] = useState<Record<string, QueuedRequest>>({});
  const [actionError, setActionError] = useState<unknown>(null);

  async function readNow(routerId: string) {
    setActionError(null);
    try {
      const q = await api<QueuedRequest>(`/routers/${routerId}/refresh`, { method: 'POST' });
      setActiveRequests((prev) => ({ ...prev, [routerId]: q }));
    } catch (err) {
      setActionError(err);
    }
  }

  return (
    <>
      <PageHeader
        icon={<Router className="size-[18px]" aria-hidden />}
        title={t('nav.routers')}
        description={t('routers.subtitle')}
        actions={
          can('admin') && activeSite ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              {t('routers.add')}
            </Button>
          ) : undefined
        }
      />

      <RouterErrorNote error={actionError} />

      <Card padded={false}>
        <Async query={routersQuery} skeleton={<div className="p-4"><SkeletonBlock lines={5} /></div>}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState
                icon={<Router className="size-6" aria-hidden />}
                title={t('routers.emptyTitle')}
                action={
                  !activeSite ? (
                    <p className="text-xs text-muted">{t('routers.noSite')}</p>
                  ) : can('admin') ? (
                    <Button variant="primary" onClick={() => setAdding(true)}>
                      <Plus className="size-4" aria-hidden />
                      {t('routers.add')}
                    </Button>
                  ) : (
                    <p className="text-xs text-muted">{t('routers.onlyAdmins')}</p>
                  )
                }
              >
                <p>{t('routers.emptyBody')}</p>
              </EmptyState>
            ) : (
              <DataTable stack>
                <thead>
                  <tr>
                    <th scope="col">{t('routers.col.router')}</th>
                    <th scope="col">{t('routers.col.status')}</th>
                    <th scope="col">{t('routers.col.delivery')}</th>
                    <th scope="col">{t('routers.col.clients')}</th>
                    <th scope="col">{t('routers.col.lastRead')}</th>
                    <th scope="col" className="text-end" />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => {
                    const req = activeRequests[r.id];
                    return (
                      <tr key={r.id}>
                        <td>
                          <div className="min-w-0">
                            <Link href={`/guard/routers/${r.id}`} className="font-semibold text-fg hover:text-accent-hover hover:underline" dir="auto">
                              {r.name}
                            </Link>
                            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                              <span className="mono">{r.address}{r.port ? `:${r.port}` : ''}</span>
                              <span>·</span>
                              <span>{r.identity?.model ?? t('routers.identityUnknown')}</span>
                              {r.identity?.firmware && <span className="mono text-faint">({r.identity.firmware})</span>}
                            </div>
                            {req && (
                              <div className="mt-2">
                                <RequestProgress
                                  requestId={req.request_id}
                                  routerId={r.id}
                                  collector={req.collector}
                                  compact
                                  onSettled={() => {
                                    setActiveRequests((prev) => {
                                      const next = { ...prev };
                                      delete next[r.id];
                                      return next;
                                    });
                                    routersQuery.reload();
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        </td>
                        <td data-label={t('routers.col.status')}>
                          <div className="space-y-1">
                            <Badge tone={HEALTH_TONE[r.status]}>{t(`routers.status.${r.status}` as Key)}</Badge>
                            {r.last_error && r.status !== 'ok' && (
                              <span className="block max-w-xs truncate text-xs text-muted" title={r.last_error} dir="auto">
                                {r.last_error}
                              </span>
                            )}
                          </div>
                        </td>
                        <td data-label={t('routers.col.delivery')}>
                          <div className="space-y-1">
                            <Badge tone={DELIVERY_TONE[r.delivery]}>{t(`routers.delivery.${r.delivery}` as Key)}</Badge>
                            {r.delivery !== 'active' && (
                              <span className="block max-w-xs text-xs text-muted" dir="auto">
                                {deliveryText(r, t, locale)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td data-label={t('routers.col.clients')}>
                          <span className="tnum font-medium">{r.client_count}</span>
                        </td>
                        <td data-label={t('routers.col.lastRead')}>
                          {r.last_ok_at ? (
                            <span className="text-muted" title={absoluteTime(r.last_ok_at, locale)}>
                              {relativeTime(r.last_ok_at, locale)}
                            </span>
                          ) : (
                            <span className="text-faint">{t('routers.never')}</span>
                          )}
                        </td>
                        <td>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            {can('technician') && (
                              <Button size="sm" variant="secondary" disabled={!!req} onClick={() => void readNow(r.id)}>
                                <RefreshCw className="size-3.5" aria-hidden />
                                {t('routers.readNow')}
                              </Button>
                            )}
                            {can('admin') && (
                              <>
                                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                                  <Pencil className="size-3.5" aria-hidden />
                                  {t('routers.edit')}
                                </Button>
                                <Button size="sm" variant="danger" onClick={() => setDeleting(r)}>
                                  <Trash2 className="size-3.5" aria-hidden />
                                  {t('routers.delete')}
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            )
          }
        </Async>
      </Card>

      {adding && activeSite && (
        <RouterWizardModal
          siteId={activeSite}
          sites={!siteId && sites.length > 1 ? sites : undefined}
          collectors={collectorsQuery.data?.items ?? []}
          onClose={() => setAdding(false)}
          onSaved={(newId) => {
            routersQuery.reload();
            routerNav.push(`/guard/routers/${newId}`);
          }}
        />
      )}

      {editing && (
        <EditRouterModal
          router={editing}
          onClose={() => setEditing(null)}
          onSaved={() => routersQuery.reload()}
        />
      )}

      {deleting && (
        <DeleteRouterModal
          router={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => routersQuery.reload()}
        />
      )}
    </>
  );
}
