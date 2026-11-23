"use client";

import {
  Background,
  Controls,
  MiniMap,
  type NodeChange,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Cable, Download, Radar, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEVICE_TYPES,
  type Topology,
  type TopologyNode,
} from "@nigafiy/shared-types";
import { Button, Card, Dot, Input, Select, statusTone } from "@/components/ui";
import { DEVICE_TYPE_LABEL } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { nodeTypes } from "./flow-nodes";
import { buildFlow } from "./build-flow";
import { Inspector } from "./inspector";

export function TopologyMap({ topology }: { topology: Topology }) {
  const { t, locale } = useI18n();
  const { resolved } = useTheme();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [selected, setSelected] = useState<{ node?: string; edge?: string }>(
    {},
  );
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>(
    {},
  );

  const flow = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (n: TopologyNode) =>
      (!q ||
        [n.label, n.ip, n.mac, n.vendor].some((v) =>
          v?.toLowerCase().includes(q),
        )) &&
      (!status || n.status === status) &&
      (!type || n.device_type === type);
    return buildFlow(topology, matches, selected.node);
  }, [topology, search, status, type, selected.node]);
  // Sizes React Flow measured. The nodes are controlled here, so they must be handed back on every
  // render: without them the minimap (which only draws nodes of known size) stays empty.
  const [measured, setMeasured] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const sizes: Record<string, { width: number; height: number }> = {};
    const positions: Record<string, { x: number; y: number }> = {};
    for (const c of changes) {
      if (c.type === "dimensions" && c.dimensions) sizes[c.id] = c.dimensions;
      if (c.type === "position" && c.position) positions[c.id] = c.position;
    }
    if (Object.keys(sizes).length) setMeasured((m) => ({ ...m, ...sizes }));
    if (Object.keys(positions).length)
      setMoved((m) => ({ ...m, ...positions }));
  }, []);
  // Positions the user dragged survive live data refreshes.
  const nodes = useMemo(
    () =>
      flow.nodes.map((n) => ({
        ...n,
        position: moved[n.id] ?? n.position,
        measured: measured[n.id],
        selected: n.id === selected.node,
      })),
    [flow.nodes, moved, measured, selected.node],
  );
  const edges = useMemo(
    () =>
      flow.edges.map((e) => ({
        ...e,
        selected: e.id === selected.edge,
        style: { ...e.style, strokeWidth: e.id === selected.edge ? 3 : 1.75 },
      })),
    [flow.edges, selected.edge],
  );
  useEffect(() => setMoved({}), [topology.site_id]);

  const exportJson = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(topology, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `topology-${topology.generated_at.slice(0, 19).replaceAll(":", "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <div className="min-w-0 space-y-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
          <div className="relative">
            <Search
              className="pointer-events-none absolute start-3 top-2.5 size-4 text-faint"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("topo.search")}
              aria-label={t("topo.search")}
              className="ps-9"
            />
          </div>
          <Select
            aria-label={t("devices.status")}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="sm:w-36"
          >
            <option value="">
              {t("devices.status")}: {t("common.all")}
            </option>
            {(["online", "offline", "unknown"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t("devices.type")}
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="sm:w-44"
          >
            <option value="">
              {t("devices.type")}: {t("common.all")}
            </option>
            {DEVICE_TYPES.map((d) => (
              <option key={d} value={d}>
                {DEVICE_TYPE_LABEL[d]?.[locale]}
              </option>
            ))}
          </Select>
          <Button onClick={exportJson}>
            <Download className="size-4" aria-hidden />
            {t("topo.export")}
          </Button>
        </div>
        <div
          className="h-[62vh] min-h-[420px] overflow-hidden rounded-[var(--radius-card)] border border-line bg-bg shadow-[var(--shadow-card)]"
          dir="ltr"
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={resolved}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
            minZoom={0.08}
            maxZoom={2}
            nodesConnectable={false}
            edgesFocusable
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) =>
              n.type !== "segment" && setSelected({ node: n.id })
            }
            onEdgeClick={(_, e) => setSelected({ edge: e.id })}
            onPaneClick={() => setSelected({})}
            onNodesChange={onNodesChange}
          >
            <Background color="var(--color-line)" gap={24} />
            <Controls showInteractive={false} />
            {nodes.length > 16 && (
              <MiniMap
                position="top-right"
                pannable
                zoomable
                ariaLabel={t("topo.minimap")}
                nodeColor={(n) => {
                  if (n.type === "segment") return "transparent";
                  if (n.type === "gateway") return "var(--color-accent)";
                  const st = (n.data as { node?: TopologyNode }).node?.status;
                  return st === "offline"
                    ? "var(--color-crit)"
                    : "var(--color-line-strong)";
                }}
                nodeStrokeColor={(n) =>
                  n.type === "segment"
                    ? "var(--color-line-strong)"
                    : "transparent"
                }
                maskColor="color-mix(in srgb, var(--color-bg) 72%, transparent)"
                bgColor="var(--color-sunken)"
                className="max-sm:hidden !rounded-[7px] !border !border-line"
              />
            )}
          </ReactFlow>
        </div>
        <ul
          className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted"
          aria-label={t("topo.legend")}
        >
          <li className="flex items-center gap-1.5">
            <svg width="28" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="28"
                y2="3"
                stroke="var(--color-accent)"
                strokeWidth="2"
              />
            </svg>
            {t("topo.legend.observed")}
          </li>
          <li className="flex items-center gap-1.5">
            <svg width="28" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="28"
                y2="3"
                stroke="var(--color-muted)"
                strokeWidth="2"
                strokeDasharray="6 5"
              />
            </svg>
            {t("topo.legend.inferred")}
          </li>
          <li className="flex items-center gap-1.5">
            <svg width="28" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="13"
                y2="3"
                stroke="var(--color-accent)"
                strokeWidth="2"
              />
              <line
                x1="15"
                y1="3"
                x2="28"
                y2="3"
                stroke="var(--color-accent)"
                strokeWidth="2"
                opacity="0.5"
              />
            </svg>
            {t("topo.legend.confidence")}
          </li>
          <li className="flex items-center gap-2">
            {(["online", "offline", "unknown"] as const).map((st) => (
              <span key={st} className="flex items-center gap-1">
                <Dot tone={statusTone(st)} />
                {t(`status.${st}`)}
              </span>
            ))}
          </li>
          <li className="flex items-center gap-1">
            <Radar className="size-3.5 text-cyan" aria-hidden />
            {t("topo.runsCollector")}
          </li>
          {topology.nodes.some((n) => n.is_switch) && (
            <li className="flex items-center gap-1">
              <Cable className="size-3.5 text-cyan" aria-hidden />
              {t("topo.legend.ports")}
            </li>
          )}
        </ul>
      </div>
      <div className="space-y-4">
        <Inspector topology={topology} selected={selected} />
        <Card title={t("topo.limitations")}>
          <ul
            className="list-disc space-y-1.5 ps-5 text-xs leading-relaxed text-muted"
            dir="auto"
          >
            {topology.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
