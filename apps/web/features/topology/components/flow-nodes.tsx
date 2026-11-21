"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { Cable, Globe, Network, Radar, Router } from "lucide-react";
import type { TopologyNode } from "@lan-detective/shared-types";
import clsx from "clsx";
import { DeviceIcon } from "@/components/device-icon";
import { Dot, statusTone } from "@/components/ui";
import { useI18n } from "@/lib/i18n";

// ── layout constants ──
export const CELL_W = 176;
export const CELL_H = 60;
export const GAP = 10;
export const PAD = 14;
export const HEADER = 40;
export const SEGMENT_GAP = 48;

export type Data = { node: TopologyNode; dim: boolean; count?: number };
export type FlowNode = Node<Data>;

const STATUS_RING = {
  ok: "bg-ok",
  warn: "bg-warn",
  crit: "bg-crit",
  idle: "bg-idle",
  info: "bg-accent",
} as const;

export function DeviceNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  const tone = n.status ? statusTone(n.status) : "idle";
  const offline = n.status === "offline";
  return (
    <div
      className={clsx(
        "flex h-full w-full items-center gap-2 rounded-[7px] border bg-raised px-2 transition-[opacity,border-color]",
        selected
          ? "border-accent ring-2 ring-accent/30"
          : n.is_switch
            ? "border-cyan/60"
            : offline
              ? "border-crit/50"
              : "border-line-strong",
        data.dim && "opacity-20",
      )}
      style={{ width: CELL_W, height: CELL_H }}
      title={n.attached_to ?? undefined}
    >
      {/* Invisible anchors: port links are drawn from a device to its switch when one of them is selected. */}
      <Handle
        type="source"
        position={Position.Top}
        className="!size-px !border-0 !bg-transparent"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        className="!size-px !border-0 !bg-transparent"
      />
      <span
        className={clsx(
          "relative grid size-8 shrink-0 place-items-center rounded-[6px] border border-line bg-surface",
          offline ? "text-faint" : "text-muted",
        )}
      >
        <DeviceIcon type={n.device_type} className="size-4" />
        {/* Status pip on the icon; the inspector names the status in words. */}
        <span
          className={clsx(
            "absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-raised",
            STATUS_RING[tone],
          )}
          aria-hidden
        />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={clsx(
            "block truncate text-xs font-medium",
            offline ? "text-muted" : "text-fg",
          )}
          dir="auto"
        >
          {n.label}
        </span>
        <span className="mono block truncate text-[11px] text-muted">
          {n.ip ?? n.mac ?? "—"}
          {n.attached_to && (
            <span className="text-faint">
              {" "}
              · {n.attached_to.split(" · ")[0]}
            </span>
          )}
        </span>
      </span>
      {n.is_switch && (
        <Cable className="size-3.5 shrink-0 text-cyan" aria-hidden />
      )}
      {n.runs_collector && (
        <Radar className="size-3.5 shrink-0 text-cyan" aria-hidden />
      )}
    </div>
  );
}

export function GatewayNode({ data, selected }: NodeProps<FlowNode>) {
  const n = data.node;
  return (
    <div
      className={clsx(
        "flex items-center gap-2.5 rounded-[9px] border-2 bg-raised px-3 shadow-[var(--shadow-card)]",
        selected ? "border-accent ring-2 ring-accent/30" : "border-accent/50",
        data.dim && "opacity-20",
      )}
      style={{ width: 220, height: 64 }}
    >
      <Handle
        type="target"
        position={Position.Bottom}
        className="!bg-line-strong"
      />
      <span className="grid size-9 shrink-0 place-items-center rounded-[7px] bg-accent text-on-accent">
        <Router className="size-[18px]" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[13px] font-semibold text-fg"
          dir="auto"
        >
          {n.label}
        </span>
        <span className="mono block truncate text-[11px] text-muted">
          {n.ip}
        </span>
      </span>
      {n.status && <Dot tone={statusTone(n.status)} />}
      <Handle
        type="source"
        position={Position.Top}
        className="!bg-line-strong"
      />
    </div>
  );
}

export function InternetNode({ selected }: NodeProps<FlowNode>) {
  const { t } = useI18n();
  return (
    <div
      className={clsx(
        "flex items-center justify-center gap-2 rounded-full border bg-surface px-5 shadow-[var(--shadow-card)]",
        selected ? "border-accent ring-2 ring-accent/30" : "border-line-strong",
      )}
      style={{ width: 160, height: 48 }}
    >
      <Globe className="size-4 text-cyan" aria-hidden />
      <span className="text-[13px] font-semibold text-fg">{t("topo.internet")}</span>
      <Handle
        type="target"
        position={Position.Bottom}
        className="!bg-line-strong"
      />
    </div>
  );
}

export function SegmentNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className="h-full w-full rounded-[10px] border border-line-strong bg-sunken/80">
      <Handle
        type="source"
        position={Position.Top}
        className="!bg-line-strong"
      />
      <div className="flex h-10 items-center gap-2 border-b border-line px-3.5">
        <Network className="size-4 text-faint" aria-hidden />
        <span className="mono text-xs font-medium text-fg">
          {data.node.label}
        </span>
        <span className="tnum ms-auto text-[11px] text-muted">
          {data.count}
        </span>
      </div>
    </div>
  );
}

export const nodeTypes = {
  device: DeviceNode,
  gateway: GatewayNode,
  internet: InternetNode,
  segment: SegmentNode,
};
