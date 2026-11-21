import type { Edge } from "@xyflow/react";
import type { Topology, TopologyNode } from "@lan-detective/shared-types";
import {
  CELL_W,
  CELL_H,
  GAP,
  PAD,
  HEADER,
  SEGMENT_GAP,
  FlowNode,
} from "./flow-nodes";

/** Lower confidence draws a fainter line; the inspector names the confidence in words. */
const EDGE_OPACITY: Record<string, number> = {
  high: 1,
  medium: 0.75,
  low: 0.5,
};

export function buildFlow(
  t: Topology,
  matches: (n: TopologyNode) => boolean,
  focus: string | undefined,
): { nodes: FlowNode[]; edges: Edge[] } {
  const segments = t.nodes.filter((n) => n.kind === "segment");
  const gateways = t.nodes.filter((n) => n.kind === "gateway");
  const memberOf = new Map(
    t.edges
      .filter((e) => e.relation === "member_of")
      .map((e) => [e.source, e.target]),
  );
  const nodes: FlowNode[] = [];
  let x = 0;
  const segmentCenter = new Map<string, number>();
  for (const seg of segments) {
    // Switches first, then the devices on each switch together, then everything without a known port.
    const attachment = new Map(
      t.edges
        .filter((e) => e.relation === "connected_to")
        .map((e) => [e.source, `${e.target}|${e.port ?? ""}`]),
    );
    const rank = (n: TopologyNode) =>
      n.is_switch
        ? "0"
        : attachment.has(n.id)
          ? `1${attachment.get(n.id)}`
          : "2";
    const members = t.nodes
      .filter((n) => n.kind === "device" && memberOf.get(n.id) === seg.id)
      .map((n, i) => ({ n, i, r: rank(n) }))
      .sort(
        (a, b) =>
          a.r.localeCompare(b.r, undefined, { numeric: true }) || a.i - b.i,
      )
      .map((x) => x.n);
    // Wide rather than tall: a few hundred devices stay readable and fit a landscape screen.
    const cols = Math.max(
      2,
      Math.min(12, Math.ceil(Math.sqrt(Math.max(1, members.length) * 2.2))),
    );
    const rows = Math.max(1, Math.ceil(members.length / cols));
    const width = PAD * 2 + cols * CELL_W + (cols - 1) * GAP;
    const height = HEADER + PAD + rows * CELL_H + (rows - 1) * GAP;
    nodes.push({
      id: seg.id,
      type: "segment",
      position: { x, y: 300 },
      data: { node: seg, dim: false, count: members.length },
      style: { width, height },
      selectable: false,
      draggable: true,
    });
    members.forEach((m, i) => {
      nodes.push({
        id: m.id,
        type: "device",
        parentId: seg.id,
        extent: "parent",
        position: {
          x: PAD + (i % cols) * (CELL_W + GAP),
          y: HEADER + Math.floor(i / cols) * (CELL_H + GAP),
        },
        data: { node: m, dim: !matches(m) },
      });
    });
    segmentCenter.set(seg.id, x + width / 2);
    x += width + SEGMENT_GAP;
  }
  const totalWidth = Math.max(x - SEGMENT_GAP, 220);
  gateways.forEach((g, i) => {
    const linked = t.edges.find(
      (e) => e.relation === "gateway_of" && e.target === g.id,
    );
    const cx =
      (linked && segmentCenter.get(linked.source)) ??
      (totalWidth / (gateways.length + 1)) * (i + 1);
    nodes.push({
      id: g.id,
      type: "gateway",
      position: { x: cx - 110, y: 150 },
      data: { node: g, dim: !matches(g) },
    });
  });
  const internet = t.nodes.find((n) => n.kind === "internet");
  if (internet) {
    const gx = nodes
      .filter((n) => n.type === "gateway")
      .map((n) => n.position.x + 110);
    const cx = gx.length
      ? gx.reduce((a, b) => a + b, 0) / gx.length
      : totalWidth / 2;
    nodes.push({
      id: internet.id,
      type: "internet",
      position: { x: cx - 80, y: 20 },
      data: { node: internet, dim: false },
    });
  }
  const edges: Edge[] = t.edges
    // Membership is shown by containment, not by hundreds of lines. Port links are drawn only for the
    // selected device or switch, for the same reason.
    .filter(
      (e) =>
        e.relation !== "member_of" &&
        (e.relation !== "connected_to" ||
          e.source === focus ||
          e.target === focus),
    )
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.relation === "connected_to" ? "default" : "smoothstep",
      label:
        e.relation === "connected_to" || e.relation === "switch_link"
          ? e.port
          : undefined,
      labelStyle: { fill: "var(--color-fg)", fontSize: 11 },
      labelBgStyle: { fill: "var(--color-raised)" },
      labelBgPadding: [4, 2] as [number, number],
      // Basis is carried by the dash (observed = solid, inferred = dashed) and by colour; confidence by opacity.
      style: {
        stroke:
          e.basis === "observed" ? "var(--color-accent)" : "var(--color-muted)",
        strokeWidth: 1.75,
        strokeDasharray: e.basis === "inferred" ? "6 5" : undefined,
        opacity: EDGE_OPACITY[e.confidence] ?? 0.6,
      },
      interactionWidth: 24,
    }));
  return { nodes, edges };
}
