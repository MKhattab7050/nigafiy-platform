'use client';

import { GitBranch, Play, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ImpactFailure, ImpactGraph, ImpactResult, SpofReport } from '@lan-detective/shared-types';
import { Async, Button, Card, EmptyState, ErrorNote, PageHeader, Select, SkeletonBlock, Tabs } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { type Key, useI18n } from '@/lib/i18n';
import { ImpactResultView } from '../components/impact-result';
import { SpofList } from '../components/spof-list';

type Tab = 'spof' | 'simulate';
const keyOf = (f: ImpactFailure) => JSON.stringify(f);

/** Everything in the twin that can be failed, with a readable label. */
function failureOptions(graph: ImpactGraph, t: (k: Key) => string) {
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const nodes = graph.nodes
    .filter((n) => n.kind !== 'collector' && n.kind !== 'internet')
    .map((n) => ({ failure: { type: 'node', id: n.id } as ImpactFailure, label: `${n.label}${n.ip ? ` (${n.ip})` : ''} · ${t(`imp.kind.${n.kind}` as Key)}` }));
  const collectors = graph.nodes.filter((n) => n.kind === 'collector' && n.collector_id).map((n) => ({ failure: { type: 'collector', id: n.collector_id! } as ImpactFailure, label: n.label }));
  const links = graph.edges.map((e) => ({ failure: { type: 'link', id: e.id } as ImpactFailure, label: `${label(e.source)} — ${label(e.target)}${e.port ? ` [${e.port}]` : ''} · ${t(`imp.basis.${e.basis}` as Key)}` }));
  const ports = graph.nodes.flatMap((n) => (n.ports ?? []).map((p) => ({ failure: { type: 'port', id: n.id, port: p } as ImpactFailure, label: `${n.label} · ${t('imp.sim.port')} ${p}` })));
  return [
    { group: t('imp.sim.kind.node'), items: nodes },
    { group: t('imp.sim.kind.collector'), items: collectors },
    { group: t('imp.sim.kind.link'), items: links },
    { group: t('imp.sim.kind.port'), items: ports },
  ].filter((g) => g.items.length > 0);
}

export function ImpactScreen() {
  const { t } = useI18n();
  const { siteId, sites } = useApp();
  const [urlSite, setUrlSite] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('spof');
  const [failures, setFailures] = useState<ImpactFailure[]>([]);
  const [pick, setPick] = useState('');
  const [result, setResult] = useState<ImpactResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Deep links from the device and map pages: /impact?site=…&device=…
  const [pendingDevice, setPendingDevice] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setUrlSite(p.get('site'));
    setPendingDevice(p.get('device'));
  }, []);

  const site = siteId ?? urlSite ?? (sites.length === 1 ? sites[0]!.id : null);
  const spof = useQuery<SpofReport>(site ? `/impact/spof${qs({ site_id: site })}` : null, ['devices', 'collectors'], 120_000);
  const graph = useQuery<ImpactGraph>(site ? `/impact/graph${qs({ site_id: site })}` : null, ['devices', 'collectors'], 120_000);
  const options = useMemo(() => (graph.data ? failureOptions(graph.data, t) : []), [graph.data, t]);
  const labelOf = (f: ImpactFailure) => (f.type === 'site' ? t('imp.sim.wholeSite') : (options.flatMap((g) => g.items).find((o) => keyOf(o.failure) === keyOf(f))?.label ?? result?.failures.find((x) => keyOf(x.failure) === keyOf(f))?.label ?? f.id));

  // A new site invalidates the selection.
  useEffect(() => {
    setFailures([]);
    setResult(null);
    setError(null);
  }, [site]);

  async function simulate(list: ImpactFailure[]) {
    if (!site || !list.length) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<ImpactResult>('/impact/simulate', { method: 'POST', body: { site_id: site, failures: list } }));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (pendingDevice && site) {
      const list: ImpactFailure[] = [{ type: 'device', id: pendingDevice }];
      setPendingDevice(null);
      setTab('simulate');
      setFailures(list);
      void simulate(list);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDevice, site]);

  const startSimulation = (f: ImpactFailure) => {
    setTab('simulate');
    setFailures([f]);
    void simulate([f]);
  };

  return (
    <>
      <PageHeader icon={<GitBranch className="size-[18px]" aria-hidden />} title={t('imp.title')} description={t('imp.intro')} />
      {!site ? (
        <Card>
          <EmptyState icon={<GitBranch />} title={t('imp.selectSite')} />
        </Card>
      ) : (
        <>
          <Tabs
            label={t('imp.title')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'spof', label: t('imp.tab.spof'), count: spof.data?.items.length },
              { value: 'simulate', label: t('imp.tab.simulate') },
            ]}
          />
          {tab === 'spof' ? (
            <Card description={t('imp.spof.hint')} padded={false}>
              <Async query={spof} skeleton={<SkeletonBlock className="p-4" lines={4} />}>
                {(r) => (
                  <>
                    {r.items.length ? <SpofList items={r.items} onSimulate={startSimulation} /> : <p className="px-4 py-3 text-[13px] text-muted">{t('imp.spof.none')}</p>}
                    {r.limitations.length > 0 && (
                      <details className="border-t border-line px-4 py-2.5 text-xs text-muted">
                        <summary className="cursor-pointer">{t('imp.result.limitations')}</summary>
                        <ul className="mt-1 list-disc space-y-0.5 ps-5">
                          {r.limitations.map((l, i) => (
                            <li key={i} dir="auto">
                              {l}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </Async>
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
              <Card title={t('imp.sim.pick')} description={t('imp.sim.pickHint')}>
                <Async query={graph} skeleton={<SkeletonBlock lines={2} />}>
                  {() => (
                    <div className="space-y-3">
                      <div className="flex gap-2">
                        <Select aria-label={t('imp.sim.pick')} value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1">
                          <option value="">—</option>
                          <option value={keyOf({ type: 'site' })}>{t('imp.sim.wholeSite')}</option>
                          {options.map((g) => (
                            <optgroup key={g.group} label={g.group}>
                              {g.items.map((o) => (
                                <option key={keyOf(o.failure)} value={keyOf(o.failure)}>
                                  {o.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </Select>
                        <Button
                          disabled={!pick || failures.some((f) => keyOf(f) === pick) || failures.length >= 50}
                          onClick={() => {
                            setFailures([...failures, JSON.parse(pick) as ImpactFailure]);
                            setPick('');
                          }}
                        >
                          <Plus className="size-3.5" aria-hidden />
                          {t('imp.sim.add')}
                        </Button>
                      </div>
                      <div>
                        <p className="mb-1.5 text-xs font-medium text-muted">{t('imp.sim.selected')}</p>
                        {failures.length === 0 ? (
                          <p className="text-[13px] text-faint">{t('imp.sim.none')}</p>
                        ) : (
                          <ul className="space-y-1">
                            {failures.map((f) => (
                              <li key={keyOf(f)} className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] border border-line px-2 py-1 text-[13px]">
                                <span className="min-w-0 truncate" dir="auto">
                                  {labelOf(f)}
                                </span>
                                <button type="button" aria-label={t('imp.sim.remove')} onClick={() => setFailures(failures.filter((x) => keyOf(x) !== keyOf(f)))} className="rounded p-1 text-muted hover:bg-raised hover:text-fg">
                                  <X className="size-3.5" aria-hidden />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="primary" busy={busy} disabled={!failures.length} onClick={() => void simulate(failures)}>
                          <Play className="size-3.5" aria-hidden />
                          {t('imp.sim.run')}
                        </Button>
                        {failures.length > 0 && (
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setFailures([]);
                              setResult(null);
                            }}
                          >
                            {t('imp.sim.clear')}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </Async>
              </Card>
              <Card title={t('imp.result.title')}>
                {error && <ErrorNote error={error} />}
                {busy && !result && <SkeletonBlock lines={4} />}
                {result ? (
                  <>
                    <ul className="mb-3 flex flex-wrap gap-1.5">
                      {result.failures.map((f) => (
                        <li key={keyOf(f.failure)} className="rounded-[5px] border border-crit/30 bg-crit/[0.07] px-2 py-0.5 text-xs" dir="auto">
                          {f.label}
                        </li>
                      ))}
                    </ul>
                    <ImpactResultView result={result} />
                  </>
                ) : (
                  !busy && !error && <p className="text-[13px] text-muted">{t('imp.sim.pickHint')}</p>
                )}
              </Card>
            </div>
          )}
        </>
      )}
    </>
  );
}
