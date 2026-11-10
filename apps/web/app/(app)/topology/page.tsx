'use client';

import { Background, Controls, type Edge, Handle, MiniMap, type Node, type NodeProps, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Cable, Download, Globe, Network, Radar, Router, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DEVICE_TYPES, type Topology, type TopologyEdge, type TopologyNode } from '@lan-detective/shared-types';
import { ConfidenceBadge } from '@/components/diagnosis';
import { Async, Badge, Button, Card, Dot, EmptyState, Fact, Input, PageHeader, Select, StatusBadge, statusTone } from '@/components/ui';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL, absoluteTime, relativeTime } from '@/lib/format';
import { type Key, useI18n } from '@/lib/i18n';

// ── layout constants ──
const CELL_W = 176;
const CELL_H = 60;
const GAP = 10;
const PAD = 14;
const HEADER = 40;
const SEGMENT_GAP = 48;

type Data = { node: TopologyNode; dim: boolean; count?: number };
type FlowNode = Node<Data>;

function DeviceNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  return (
    <div
      className={`flex h-full w-full items-center gap-2 rounded-md border bg-raised px-2.5 transition-opacity ${selected ? 'border-accent' : n.is_switch ? 'border-cyan/60' : 'border-line-strong'} ${data.dim ? 'opacity-20' : ''}`}
      style={{ width: CELL_W, height: CELL_H }}
      title={n.attached_to ?? undefined}
    >
      {/* Invisible anchors: port links are drawn from a device to its switch when one of them is selected. */}
      <Handle type="source" position={Position.Top} className="!size-px !border-0 !bg-transparent" />
      <Handle type="target" position={Position.Bottom} className="!size-px !border-0 !bg-transparent" />
      <Dot tone={n.status ? statusTone(n.status) : 'idle'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-fg" dir="auto">
          {n.label}
        </span>
        <span className="mono block truncate text-[11px] text-muted">
          {n.ip ?? n.mac ?? '—'}
          {n.attached_to && <span className="text-faint"> · {n.attached_to.split(' · ')[0]}</span>}
        </span>
      </span>
      {n.is_switch && <Cable className="size-3.5 shrink-0 text-cyan" aria-hidden />}
      {n.runs_collector && <Radar className="size-3.5 shrink-0 text-cyan" aria-hidden />}
    </div>
  );
}

function GatewayNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  return (
    <div className={`flex items-center gap-2.5 rounded-lg border-2 bg-raised px-3 ${selected ? 'border-accent' : 'border-accent/50'} ${data.dim ? 'opacity-20' : ''}`} style={{ width: 220, height: 64 }}>
      <Handle type="target" position={Position.Bottom} className="!bg-line-strong" />
      <Router className="size-5 shrink-0 text-accent-hover" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-fg" dir="auto">
          {n.label}
        </span>
        <span className="mono block truncate text-[11px] text-muted">{n.ip}</span>
      </span>
      {n.status && <Dot tone={statusTone(n.status)} />}
      <Handle type="source" position={Position.Top} className="!bg-line-strong" />
    </div>
  );
}

function InternetNode({ selected }: NodeProps<FlowNode>) {
  return (
    <div className={`flex items-center justify-center gap-2 rounded-full border bg-surface px-5 ${selected ? 'border-accent' : 'border-line-strong'}`} style={{ width: 160, height: 48 }}>
      <Globe className="size-4 text-cyan" aria-hidden />
      <span className="text-[13px] font-semibold text-fg">Internet</span>
      <Handle type="target" position={Position.Bottom} className="!bg-line-strong" />
    </div>
  );
}

function SegmentNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className="h-full w-full rounded-lg border border-dashed border-line-strong bg-surface/70">
      <Handle type="source" position={Position.Top} className="!bg-line-strong" />
      <div className="flex h-10 items-center gap-2 px-3.5">
        <Network className="size-4 text-faint" aria-hidden />
        <span className="mono text-xs font-medium text-fg">{data.node.label}</span>
        <span className="tnum ms-auto text-[11px] text-muted">{data.count}</span>
      </div>
    </div>
  );
}

const nodeTypes = { device: DeviceNode, gateway: GatewayNode, internet: InternetNode, segment: SegmentNode };

function buildFlow(t: Topology, matches: (n: TopologyNode) => boolean, focus: string | undefined): { nodes: FlowNode[]; edges: Edge[] } {
  const segments = t.nodes.filter((n) => n.kind === 'segment');
  const gateways = t.nodes.filter((n) => n.kind === 'gateway');
  const memberOf = new Map(t.edges.filter((e) => e.relation === 'member_of').map((e) => [e.source, e.target]));
  const nodes: FlowNode[] = [];
  let x = 0;
  const segmentCenter = new Map<string, number>();
  for (const seg of segments) {
    // Switches first, then the devices on each switch together, then everything without a known port.
    const attachment = new Map(t.edges.filter((e) => e.relation === 'connected_to').map((e) => [e.source, `${e.target}|${e.port ?? ''}`]));
    const rank = (n: TopologyNode) => (n.is_switch ? '0' : attachment.has(n.id) ? `1${attachment.get(n.id)}` : '2');
    const members = t.nodes
      .filter((n) => n.kind === 'device' && memberOf.get(n.id) === seg.id)
      .map((n, i) => ({ n, i, r: rank(n) }))
      .sort((a, b) => a.r.localeCompare(b.r, undefined, { numeric: true }) || a.i - b.i)
      .map((x) => x.n);
    // Wide rather than tall: a few hundred devices stay readable and fit a landscape screen.
    const cols = Math.max(2, Math.min(12, Math.ceil(Math.sqrt(Math.max(1, members.length) * 2.2))));
    const rows = Math.max(1, Math.ceil(members.length / cols));
    const width = PAD * 2 + cols * CELL_W + (cols - 1) * GAP;
    const height = HEADER + PAD + rows * CELL_H + (rows - 1) * GAP;
    nodes.push({ id: seg.id, type: 'segment', position: { x, y: 300 }, data: { node: seg, dim: false, count: members.length }, style: { width, height }, selectable: false, draggable: true });
    members.forEach((m, i) => {
      nodes.push({
        id: m.id,
        type: 'device',
        parentId: seg.id,
        extent: 'parent',
        position: { x: PAD + (i % cols) * (CELL_W + GAP), y: HEADER + Math.floor(i / cols) * (CELL_H + GAP) },
        data: { node: m, dim: !matches(m) },
      });
    });
    segmentCenter.set(seg.id, x + width / 2);
    x += width + SEGMENT_GAP;
  }
  const totalWidth = Math.max(x - SEGMENT_GAP, 220);
  gateways.forEach((g, i) => {
    const linked = t.edges.find((e) => e.relation === 'gateway_of' && e.target === g.id);
    const cx = (linked && segmentCenter.get(linked.source)) ?? (totalWidth / (gateways.length + 1)) * (i + 1);
    nodes.push({ id: g.id, type: 'gateway', position: { x: cx - 110, y: 150 }, data: { node: g, dim: !matches(g) } });
  });
  const internet = t.nodes.find((n) => n.kind === 'internet');
  if (internet) {
    const gx = nodes.filter((n) => n.type === 'gateway').map((n) => n.position.x + 110);
    const cx = gx.length ? gx.reduce((a, b) => a + b, 0) / gx.length : totalWidth / 2;
    nodes.push({ id: internet.id, type: 'internet', position: { x: cx - 80, y: 20 }, data: { node: internet, dim: false } });
  }
  const edges: Edge[] = t.edges
    // Membership is shown by containment, not by hundreds of lines. Port links are drawn only for the
    // selected device or switch, for the same reason.
    .filter((e) => e.relation !== 'member_of' && (e.relation !== 'connected_to' || e.source === focus || e.target === focus))
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.relation === 'connected_to' ? 'default' : 'smoothstep',
      label: e.relation === 'connected_to' || e.relation === 'switch_link' ? e.port : undefined,
      labelStyle: { fill: 'var(--color-fg)', fontSize: 11 },
      labelBgStyle: { fill: 'var(--color-raised)' },
      labelBgPadding: [4, 2] as [number, number],
      style: { stroke: e.confidence === 'high' ? 'var(--color-accent)' : 'var(--color-idle)', strokeWidth: 1.75, strokeDasharray: e.basis === 'inferred' ? '6 5' : undefined },
      interactionWidth: 24,
    }));
  return { nodes, edges };
}

function EdgeEvidence({ edge }: { edge: TopologyEdge }) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={edge.basis === 'observed' ? 'ok' : 'idle'} dot={false}>
          {t(`topo.basis.${edge.basis}`)}
        </Badge>
        <ConfidenceBadge confidence={edge.confidence} />
      </div>
      <p className="text-[13px] leading-relaxed text-fg" dir="auto">
        {edge.evidence}
      </p>
      <p className="text-xs text-muted">
        {t('topo.evidenceSource')}: {edge.evidence_source}
      </p>
      <p className="text-xs text-muted">
        {t('topo.lastVerified')}: {edge.last_verified_at ? <span title={absoluteTime(edge.last_verified_at, locale)}>{relativeTime(edge.last_verified_at, locale)}</span> : '—'}
      </p>
    </div>
  );
}

function Inspector({ topology, selected }: { topology: Topology; selected: { node?: string; edge?: string } }) {
  const { t, locale } = useI18n();
  const label = (id: string) => topology.nodes.find((n) => n.id === id)?.label ?? id;
  if (selected.edge) {
    const e = topology.edges.find((x) => x.id === selected.edge);
    if (!e) return null;
    return (
      <Card title={`${t('topo.link')}: ${label(e.source)} ${t(`topo.relation.${e.relation}` as Key)} ${label(e.target)}`}>
        <EdgeEvidence edge={e} />
      </Card>
    );
  }
  const n = topology.nodes.find((x) => x.id === selected.node);
  if (!n) return <p className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-[13px] text-muted">{t('topo.select')}</p>;
  const edges = topology.edges.filter((e) => e.source === n.id || (n.kind === 'gateway' && e.target === n.id && e.relation !== 'connected_to') || (e.relation === 'switch_link' && e.target === n.id));
  const attached = topology.edges.filter((e) => e.relation === 'connected_to' && e.target === n.id).length;
  return (
    <Card title={<span dir="auto">{n.label}</span>} action={n.status && <StatusBadge status={n.status} />}>
      <dl>
        <Fact label={t('devices.type')}>{n.kind === 'gateway' ? t('topo.gateway') : n.kind === 'internet' ? t('topo.internet') : n.device_type ? DEVICE_TYPE_LABEL[n.device_type]?.[locale] : '—'}</Fact>
        {n.ip && (
          <Fact label={t('device.ip')}>
            <span className="mono">{n.ip}</span>
          </Fact>
        )}
        {n.mac && (
          <Fact label={t('device.mac')} source={n.vendor ?? undefined}>
            <span className="mono">{n.mac}</span>
          </Fact>
        )}
        {n.segment && (
          <Fact label={t('topo.segment')}>
            <span className="mono">{n.segment}</span>
          </Fact>
        )}
        {n.attached_to && (
          <Fact label={t('topo.port')}>
            <span dir="auto">{n.attached_to}</span>
          </Fact>
        )}
        {n.last_seen_at && <Fact label={t('device.lastSeen')}>{relativeTime(n.last_seen_at, locale)}</Fact>}
      </dl>
      {n.is_switch && (
        <p className="mt-2 text-xs text-cyan">
          {t('topo.switch')} · {attached} {t('topo.attached')}
        </p>
      )}
      {n.runs_collector && <p className="mt-2 text-xs text-cyan">{t('topo.runsCollector')}</p>}
      {n.kind === 'gateway' && !n.device_id && <p className="mt-2 text-xs leading-relaxed text-muted">{t('topo.notInInventory')}</p>}
      {edges.map((e) => (
        <div key={e.id} className="mt-4 border-t border-line pt-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint" dir="auto">
            {label(e.source)} {t(`topo.relation.${e.relation}` as Key)} {label(e.target)}
          </p>
          <EdgeEvidence edge={e} />
        </div>
      ))}
      {n.device_id && (
        <Link href={`/devices/${n.device_id}`} className="mt-4 inline-block text-[13px] font-medium text-accent-hover hover:underline">
          {t('topo.openDevice')} →
        </Link>
      )}
    </Card>
  );
}

function TopologyMap({ topology }: { topology: Topology }) {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [selected, setSelected] = useState<{ node?: string; edge?: string }>({});
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});

  const flow = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (n: TopologyNode) =>
      (!q || [n.label, n.ip, n.mac, n.vendor].some((v) => v?.toLowerCase().includes(q))) && (!status || n.status === status) && (!type || n.device_type === type);
    return buildFlow(topology, matches, selected.node);
  }, [topology, search, status, type, selected.node]);
  // Positions the user dragged survive live data refreshes.
  const nodes = useMemo(() => flow.nodes.map((n) => ({ ...n, position: moved[n.id] ?? n.position, selected: n.id === selected.node })), [flow.nodes, moved, selected.node]);
  const edges = useMemo(() => flow.edges.map((e) => ({ ...e, selected: e.id === selected.edge, style: { ...e.style, strokeWidth: e.id === selected.edge ? 3 : 1.75 } })), [flow.edges, selected.edge]);
  useEffect(() => setMoved({}), [topology.site_id]);

  const exportJson = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(topology, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `topology-${topology.generated_at.slice(0, 19).replaceAll(':', '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-faint" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('topo.search')} aria-label={t('topo.search')} className="ps-9" />
          </div>
          <Select aria-label={t('devices.status')} value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-36">
            <option value="">
              {t('devices.status')}: {t('common.all')}
            </option>
            {(['online', 'offline', 'unknown'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </Select>
          <Select aria-label={t('devices.type')} value={type} onChange={(e) => setType(e.target.value)} className="sm:w-44">
            <option value="">
              {t('devices.type')}: {t('common.all')}
            </option>
            {DEVICE_TYPES.map((d) => (
              <option key={d} value={d}>
                {DEVICE_TYPE_LABEL[d]?.[locale]}
              </option>
            ))}
          </Select>
          <Button onClick={exportJson}>
            <Download className="size-4" aria-hidden />
            {t('topo.export')}
          </Button>
        </div>
        <div className="h-[62vh] min-h-[420px] overflow-hidden rounded-lg border border-line bg-bg" dir="ltr">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
            minZoom={0.08}
            maxZoom={2}
            nodesConnectable={false}
            edgesFocusable
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: false }}
            onNodeClick={(_, n) => n.type !== 'segment' && setSelected({ node: n.id })}
            onEdgeClick={(_, e) => setSelected({ edge: e.id })}
            onPaneClick={() => setSelected({})}
            onNodeDragStop={(_, n) => setMoved((m) => ({ ...m, [n.id]: n.position }))}
          >
            <Background color="var(--color-line)" gap={24} />
            <Controls showInteractive={false} />
            <MiniMap position="top-right" pannable zoomable nodeColor={(n) => (n.type === 'segment' ? 'transparent' : 'var(--color-line-strong)')} maskColor="rgba(7,13,26,.7)" style={{ background: 'var(--color-surface)' }} />
          </ReactFlow>
        </div>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>
            <span className="me-1.5 inline-block w-6 border-t-2 border-accent align-middle" />
            {t('topo.legend.observed')}
          </span>
          <span>
            <span className="me-1.5 inline-block w-6 border-t-2 border-dashed border-idle align-middle" />
            {t('topo.legend.inferred')}
          </span>
          <span>
            <Radar className="me-1 inline size-3.5 text-cyan" aria-hidden />
            {t('topo.runsCollector')}
          </span>
          {topology.nodes.some((n) => n.is_switch) && (
            <span>
              <Cable className="me-1 inline size-3.5 text-cyan" aria-hidden />
              {t('topo.legend.ports')}
            </span>
          )}
        </p>
      </div>
      <div className="space-y-4">
        <Inspector topology={topology} selected={selected} />
        <Card title={t('topo.limitations')}>
          <ul className="list-disc space-y-1.5 ps-5 text-xs leading-relaxed text-muted" dir="auto">
            {topology.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

export default function TopologyPage() {
  const { t } = useI18n();
  const { siteId, sites } = useApp();
  // Topology is per site; with a single site there is nothing to choose.
  const site = siteId ?? (sites.length === 1 ? sites[0]!.id : null);
  const query = useQuery<Topology>(site ? `/topology?site_id=${site}` : null, ['devices', 'collectors', 'checks'], 60_000);
  return (
    <>
      <PageHeader title={t('topo.title')} description={t('topo.intro')} />
      {!site ? (
        <Card>
          <EmptyState icon={<Network className="size-8" />} title={t('topo.selectSite')} />
        </Card>
      ) : (
        <Async query={query}>
          {(topology) =>
            topology.nodes.some((n) => n.kind === 'device' || n.kind === 'gateway') ? (
              <TopologyMap topology={topology} />
            ) : (
              <Card>
                <EmptyState icon={<Network className="size-8" />} title={t('topo.empty')} />
              </Card>
            )
          }
        </Async>
      )}
    </>
  );
}
