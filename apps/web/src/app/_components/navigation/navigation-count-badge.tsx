import type { DashboardCountsOut } from "@cubby/schemas/dashboard";
import {
  type BrowserRoutedEntity,
  type CountableEntity,
  countableEntities,
} from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";

import { dashboard } from "~/lib/dashboard.functions";

const additionalCountEntities = [
  "ledgerParty",
  "ledgerTransfer",
  "vendorAccount",
  "productCategory",
  "device",
] as const;
type LocalCountEntity =
  | CountableEntity
  | (typeof additionalCountEntities)[number];

function isLocalCountEntity(
  entity: BrowserRoutedEntity,
): entity is LocalCountEntity {
  return (
    countableEntities.some((candidate) => candidate === entity) ||
    additionalCountEntities.some((candidate) => candidate === entity)
  );
}

export function navigationCount(
  counts: Partial<DashboardCountsOut> | undefined,
  entity: BrowserRoutedEntity | "usdaFood" | undefined,
): number | undefined {
  if (!counts || !entity) return undefined;
  if (entity === "usdaFood") {
    return counts.usdaFoodsAvailable ? counts.usdaFoods : undefined;
  }
  return isLocalCountEntity(entity) ? counts[entity] : undefined;
}

/** Counts label roster destinations only; an absent response field stays absent. */
export function NavigationCountBadge({
  entity,
}: {
  entity: BrowserRoutedEntity | undefined;
}) {
  const query = useQuery({
    ...dashboard.counts.queryOptions(),
    enabled: entity !== undefined,
  });
  const count = navigationCount(query.data, entity);
  if (count === undefined) return null;
  return (
    <span className="ml-auto shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground tabular-nums">
      <span aria-hidden="true">{count.toLocaleString()}</span>
      <span className="sr-only">{count.toLocaleString()} records</span>
    </span>
  );
}
