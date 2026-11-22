"use client";

import { MousePointerClick } from "lucide-react";
import Link from "next/link";
import type { Topology, TopologyEdge } from "@lan-detective/shared-types";
import {
  Badge,
  Card,
  Fact,
  StatusBadge,
  ConfidenceBadge,
} from "@/components/ui";
import { DEVICE_TYPE_LABEL, absoluteTime, relativeTime } from "@/lib/format";
import { type Key, useI18n } from "@/lib/i18n";
import { DeviceLink } from '@/components/device-link';

export function EdgeEvidence({ edge }: { edge: TopologyEdge }) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={edge.basis === "observed" ? "ok" : "idle"} dot={false}>
          {t(`topo.basis.${edge.basis}`)}
        </Badge>
        <ConfidenceBadge confidence={edge.confidence} />
      </div>
      <p className="text-[13px] leading-relaxed text-fg" dir="auto">
        {edge.evidence}
      </p>
      <p className="text-xs text-muted">
        {t("topo.evidenceSource")}: {edge.evidence_source}
      </p>
      <p className="text-xs text-muted">
        {t("topo.lastVerified")}:{" "}
        {edge.last_verified_at ? (
          <span title={absoluteTime(edge.last_verified_at, locale)}>
            {relativeTime(edge.last_verified_at, locale)}
          </span>
        ) : (
          "—"
        )}
      </p>
    </div>
  );
}

export function Inspector({
  topology,
  selected,
}: {
  topology: Topology;
  selected: { node?: string; edge?: string };
}) {
  const { t, locale } = useI18n();
  const label = (id: string) =>
    topology.nodes.find((n) => n.id === id)?.label ?? id;
  if (selected.edge) {
    const e = topology.edges.find((x) => x.id === selected.edge);
    if (!e) return null;
    return (
      <Card
        title={`${t("topo.link")}: ${label(e.source)} ${t(`topo.relation.${e.relation}` as Key)} ${label(e.target)}`}
      >
        <EdgeEvidence edge={e} />
      </Card>
    );
  }
  const n = topology.nodes.find((x) => x.id === selected.node);
  if (!n)
    return (
      <p className="flex items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-line-strong bg-surface px-4 py-6 text-center text-[13px] text-muted">
        <MousePointerClick className="size-4 shrink-0 text-faint" aria-hidden />
        {t("topo.select")}
      </p>
    );
  const edges = topology.edges.filter(
    (e) =>
      e.source === n.id ||
      (n.kind === "gateway" &&
        e.target === n.id &&
        e.relation !== "connected_to") ||
      (e.relation === "switch_link" && e.target === n.id),
  );
  const attached = topology.edges.filter(
    (e) => e.relation === "connected_to" && e.target === n.id,
  ).length;
  return (
    <Card
      title={<span dir="auto">{n.label}</span>}
      action={n.status && <StatusBadge status={n.status} />}
    >
      <dl>
        <Fact label={t("devices.type")}>
          {n.kind === "gateway"
            ? t("topo.gateway")
            : n.kind === "internet"
              ? t("topo.internet")
              : n.device_type
                ? DEVICE_TYPE_LABEL[n.device_type]?.[locale]
                : "—"}
        </Fact>
        {n.ip && (
          <Fact label={t("device.ip")}>
            <span className="mono">{n.ip}</span>
          </Fact>
        )}
        {n.mac && (
          <Fact label={t("device.mac")} source={n.vendor ?? undefined}>
            <span className="mono">{n.mac}</span>
          </Fact>
        )}
        {n.segment && (
          <Fact label={t("topo.segment")}>
            <span className="mono">{n.segment}</span>
          </Fact>
        )}
        {n.attached_to && (
          <Fact label={t("topo.port")}>
            <span dir="auto">{n.attached_to}</span>
          </Fact>
        )}
        {n.last_seen_at && (
          <Fact label={t("device.lastSeen")}>
            {relativeTime(n.last_seen_at, locale)}
          </Fact>
        )}
      </dl>
      {n.is_switch && (
        <p className="mt-2 text-xs text-cyan">
          {t("topo.switch")} · {attached} {t("topo.attached")}
        </p>
      )}
      {n.runs_collector && (
        <p className="mt-2 text-xs text-cyan">{t("topo.runsCollector")}</p>
      )}
      {n.mndp && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-muted">
            {t("topo.mndp.title")}
            <Badge tone="ok" dot={false}>
              {t("topo.basis.observed")}
            </Badge>
          </p>
          <dl>
            {n.mndp.identity && (
              <Fact label={t("topo.mndp.identity")}>
                <span dir="auto">{n.mndp.identity}</span>
              </Fact>
            )}
            {(n.mndp.board || n.mndp.platform) && (
              <Fact label={t("topo.mndp.board")}>
                <span dir="auto">{n.mndp.board ?? n.mndp.platform}</span>
              </Fact>
            )}
            {n.mndp.version && (
              <Fact label={t("topo.mndp.version")}>
                <span dir="ltr">{n.mndp.version}</span>
              </Fact>
            )}
            {n.mndp.interface_name && (
              <Fact label={t("topo.mndp.interface")}>
                <span className="mono" dir="ltr">{n.mndp.interface_name}</span>
              </Fact>
            )}
            <Fact label={t("topo.mndp.heardBy")}>
              <span dir="auto">{n.mndp.heard_by}</span>
            </Fact>
            <Fact label={t("topo.lastVerified")}>
              <span title={absoluteTime(n.mndp.last_seen_at, locale)}>{relativeTime(n.mndp.last_seen_at, locale)}</span>
            </Fact>
          </dl>
          <p className="mt-1 text-xs text-muted">{t("topo.mndp.note")}</p>
        </div>
      )}
      {n.kind === "gateway" && !n.device_id && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {t("topo.notInInventory")}
        </p>
      )}
      {edges.map((e) => (
        <div key={e.id} className="mt-4 border-t border-line pt-3">
          <p className="mb-2 text-xs font-semibold text-muted" dir="auto">
            {label(e.source)} {t(`topo.relation.${e.relation}` as Key)}{" "}
            {label(e.target)}
          </p>
          <EdgeEvidence edge={e} />
        </div>
      ))}
      {n.device_id && (
        <DeviceLink
          id={n.device_id}
          className="mt-4 inline-block text-[13px] font-medium text-accent-hover hover:underline"
        >
          {t("topo.openDevice")} →
        </DeviceLink>
      )}
    </Card>
  );
}
