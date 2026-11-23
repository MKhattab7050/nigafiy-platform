'use client';

import clsx from 'clsx';
import { Play, RotateCcw, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Collector, ToolKind, ToolRun } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, EmptyState, ErrorNote, Field, Input, PageHeader, Segmented, Select } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { TOOLS, COMMON_PORTS, runTone } from '../components/tools';
import { ProbeResultView } from '../components/probe-result-view';
import { toolboxText } from '../text';

export function ToolboxScreen() {
  const { locale, t } = useI18n();
  const tx = toolboxText(locale);
  const { sites, siteId, can } = useApp();

  const [chosenSite, setChosenSite] = useState<string>('');
  const activeSite = siteId ?? (chosenSite || sites[0]?.id || '');

  const [tool, setTool] = useState<ToolKind>('ping');
  const [target, setTarget] = useState('1.1.1.1');
  const [port, setPort] = useState('443');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Pre-fill from query string when linked from a device page (e.g. /toolbox?target=192.168.1.50&tool=ping)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const qTarget = params.get('target');
    const qTool = params.get('tool') as ToolKind | null;
    const qPort = params.get('port');
    const qSite = params.get('site_id');
    if (qTarget) setTarget(qTarget);
    if (qTool && TOOLS.includes(qTool)) setTool(qTool);
    if (qPort) setPort(qPort);
    if (qSite) setChosenSite(qSite);
  }, []);

  const collectorsQuery = useQuery<{ items: Collector[] }>('/collectors', ['collectors'], 20_000);
  const siteCollectors = useMemo(
    () => (collectorsQuery.data?.items ?? []).filter((c) => c.site_id === activeSite && c.status === 'active' && c.connection_state === 'online'),
    [collectorsQuery.data, activeSite],
  );
  const gatewayIp = siteCollectors.find((c) => c.gateway_ip)?.gateway_ip ?? null;

  // Poll every 2.5s while any probe is pending so the result appears right away
  const runsQuery = useQuery<{ items: ToolRun[] }>(
    activeSite ? `/toolbox${qs({ site_id: activeSite, limit: 30 })}` : null,
    ['checks', 'collectors'],
    3_000,
  );

  const runs = runsQuery.data?.items ?? [];
  const selected = runs.find((r) => r.id === selectedId) ?? runs[0] ?? null;

  async function submitProbe(override?: { tool: ToolKind; target: string; port: number | null }) {
    if (!activeSite) return;
    setBusy(true);
    setError(null);
    const useTool = override ? override.tool : tool;
    const useTarget = (override ? override.target : target).trim();
    const usePort = override ? override.port : useTool === 'tcp' ? Number(port) || null : null;
    try {
      const created = await api<ToolRun>('/toolbox', {
        method: 'POST',
        body: { site_id: activeSite, tool: useTool, target: useTarget, port: usePort },
      });
      setSelectedId(created.id);
      runsQuery.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  function pickQuickTarget(val: string) {
    setTarget(val);
    if (tool === 'dns' && /^\d+\.\d+\.\d+\.\d+$/.test(val)) {
      setTool('ping');
    } else if (tool === 'rdns' && !/^\d+\.\d+\.\d+\.\d+$/.test(val)) {
      setTool('dns');
    }
  }

  return (
    <>
      <PageHeader icon={<Wrench className="size-[18px]" aria-hidden />} title={tx.title} description={tx.subtitle} />

      {error && (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Card title={tx.runTitle}>
            {!can('technician') ? (
              <p className="text-[13px] text-muted">{tx.viewerNotice}</p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitProbe();
                }}
                className="space-y-4"
              >
                {!siteId && sites.length > 1 && (
                  <Field label={tx.site}>
                    {(id) => (
                      <Select id={id} value={activeSite} onChange={(e) => setChosenSite(e.target.value)}>
                        {sites.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted">{tx.tool}</label>
                  <div className="flex flex-wrap gap-1.5">
                    <Segmented
                      value={tool}
                      label={tx.tool}
                      options={TOOLS.map((k) => ({ value: k, label: tx.tools[k] }))}
                      onChange={(next) => {
                        setTool(next);
                        if (next === 'dns' && /^\d+\.\d+\.\d+\.\d+$/.test(target.trim())) setTarget('example.com');
                        if ((next === 'rdns' || next === 'ports') && !/^\d+\.\d+\.\d+\.\d+$/.test(target.trim())) setTarget(gatewayIp ?? '192.168.1.1');
                      }}
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-faint">{tx.toolHints[tool]}</p>
                </div>

                <div className={clsx('grid gap-3', tool === 'tcp' ? 'sm:grid-cols-[1fr_9rem]' : '')}>
                  <Field label={tx.target}>
                    {(id) => (
                      <Input
                        id={id}
                        dir="ltr"
                        className="mono"
                        value={target}
                        onChange={(e) => setTarget(e.target.value)}
                        placeholder={tx.targetPlaceholder[tool]}
                        required
                      />
                    )}
                  </Field>
                  {tool === 'tcp' && (
                    <Field label={tx.port}>
                      {(id) => (
                        <Input
                          id={id}
                          dir="ltr"
                          type="number"
                          min={1}
                          max={65535}
                          className="mono"
                          value={port}
                          onChange={(e) => setPort(e.target.value)}
                          required
                        />
                      )}
                    </Field>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-faint">{tx.quickTargets}</span>
                  {gatewayIp && (
                    <button
                      type="button"
                      onClick={() => pickQuickTarget(gatewayIp)}
                      className="mono rounded border border-line-strong bg-raised px-2 py-0.5 text-muted hover:text-fg"
                    >
                      {tx.gatewayLabel} ({gatewayIp})
                    </button>
                  )}
                  {['1.1.1.1', '8.8.8.8', 'example.com'].map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => pickQuickTarget(q)}
                      className="mono rounded border border-line-strong bg-raised px-2 py-0.5 text-muted hover:text-fg"
                    >
                      {q}
                    </button>
                  ))}
                </div>

                {tool === 'tcp' && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-faint">{tx.commonPorts}</span>
                    {COMMON_PORTS.map((p) => (
                      <button
                        key={p.port}
                        type="button"
                        onClick={() => setPort(String(p.port))}
                        className={clsx(
                          'mono rounded border px-2 py-0.5 transition-colors',
                          Number(port) === p.port ? 'border-accent bg-accent/15 text-fg' : 'border-line-strong bg-raised text-muted hover:text-fg',
                        )}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  {collectorsQuery.data && siteCollectors.length === 0 ? (
                    <p className="text-xs text-warn">{tx.noCollector}</p>
                  ) : (
                    <span className="text-xs text-faint">
                      {siteCollectors[0] ? `${tx.measuredFrom}: ${siteCollectors[0].name}` : ''}
                    </span>
                  )}
                  <Button type="submit" variant="primary" busy={busy} disabled={siteCollectors.length === 0 || !target.trim()}>
                    <Play className="size-3.5" aria-hidden />
                    {tx.run}
                  </Button>
                </div>
              </form>
            )}
          </Card>

          <Card
            title={
              selected ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{tx.tools[selected.tool]}</span>
                  <code dir="ltr" className="mono rounded bg-raised px-1.5 py-0.5 text-xs text-fg">
                    {selected.target}
                    {selected.port ? `:${selected.port}` : ''}
                  </code>
                  <Badge tone={runTone(selected)}>{tx.status[selected.status]}</Badge>
                </span>
              ) : (
                tx.resultTitle
              )
            }
            action={
              selected && can('technician') ? (
                <Button
                  size="sm"
                  disabled={busy || siteCollectors.length === 0}
                  onClick={() => void submitProbe({ tool: selected.tool, target: selected.target, port: selected.port })}
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                  {tx.rerun}
                </Button>
              ) : undefined
            }
          >
            {!selected ? (
              <EmptyState icon={<Wrench className="size-8" />} title={tx.resultTitle}>
                {tx.selectPrompt}
              </EmptyState>
            ) : (
              <ProbeResultView run={selected} locale={locale} />
            )}
          </Card>
        </div>

        <Card title={tx.historyTitle} padded={false}>
          <Async query={runsQuery}>
            {({ items }) =>
              items.length === 0 ? (
                <div className="p-4 text-center text-[13px] text-muted">{tx.historyEmpty}</div>
              ) : (
                <ul className="divide-y divide-line">
                  {items.map((r) => {
                    const active = selected?.id === r.id;
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(r.id)}
                          className={clsx(
                            'flex w-full flex-col gap-1 px-4 py-2.5 text-start transition-colors',
                            active ? 'bg-accent/10' : 'hover:bg-raised/60',
                          )}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-fg">{tx.tools[r.tool]}</span>
                            <Badge tone={runTone(r)}>{tx.status[r.status]}</Badge>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <code dir="ltr" className="mono truncate text-xs text-muted">
                              {r.target}
                              {r.port ? `:${r.port}` : ''}
                            </code>
                            <span className="shrink-0 text-[11px] text-faint">{relativeTime(r.created_at, locale)}</span>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )
            }
          </Async>
        </Card>
      </div>
    </>
  );
}
