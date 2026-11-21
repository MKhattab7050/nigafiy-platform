"use client";

import { Network } from "lucide-react";
import type { Topology } from "@lan-detective/shared-types";
import { TopologyArt } from "@/components/illustrations";
import {
  Async,
  Card,
  EmptyState,
  PageHeader,
  SkeletonBlock,
} from "@/components/ui";
import { useApp, useQuery } from "@/lib/app";
import { useI18n } from "@/lib/i18n";
import { TopologyMap } from "../components/topology-map";
import { FeatureBoundary } from "@/components/error-boundary";
import { TopologySpofCard } from "@/features/impact";

export function TopologyScreen() {
  const { t } = useI18n();
  const { siteId, sites } = useApp();
  // Topology is per site; with a single site there is nothing to choose.
  const site = siteId ?? (sites.length === 1 ? sites[0]!.id : null);
  const query = useQuery<Topology>(
    site ? `/topology?site_id=${site}` : null,
    ["devices", "collectors", "checks"],
    60_000,
  );
  return (
    <>
      <PageHeader
        icon={<Network className="size-[18px]" aria-hidden />}
        title={t("topo.title")}
        description={t("topo.intro")}
      />
      {!site ? (
        <Card>
          <EmptyState
            icon={<Network className="size-8" />}
            title={t("topo.selectSite")}
          />
        </Card>
      ) : (
        <Async query={query} skeleton={<SkeletonBlock chart lines={2} />}>
          {(topology) =>
            topology.nodes.some(
              (n) => n.kind === "device" || n.kind === "gateway",
            ) ? (
              <>
                <TopologyMap topology={topology} />
                <div className="mt-4">
                  <FeatureBoundary>
                    <TopologySpofCard siteId={site} />
                  </FeatureBoundary>
                </div>
              </>
            ) : (
              <Card>
                <EmptyState
                  illustration={<TopologyArt className="w-56" />}
                  title={t("topo.empty")}
                />
              </Card>
            )
          }
        </Async>
      )}
    </>
  );
}
