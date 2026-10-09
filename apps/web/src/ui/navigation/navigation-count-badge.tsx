import {
  dashboardLocalCounts,
  type DashboardCountsOut,
} from "@cubby/schemas/dashboard";
import type { BrowserRoutedEntity } from "@cubby/schemas/entity-manifest";
import { useQuery } from "@tanstack/react-query";

import { dashboard } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCount } from "~/lib/utils";

const localCountKeys = dashboardLocalCounts.keyof();

export function navigationCount(
  counts: Partial<DashboardCountsOut> | undefined,
  entity: BrowserRoutedEntity | "usdaFood" | undefined,
): number | undefined {
  if (!counts || !entity) return undefined;
  if (entity === "usdaFood") {
    return counts.usdaFoodsAvailable ? counts.usdaFoods : undefined;
  }
  const key = localCountKeys.safeParse(entity);
  return key.success ? counts[key.data] : undefined;
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
    <span className="ml-auto shrink-0 pl-1 text-xs text-muted-foreground tabular-nums">
      <span aria-hidden="true">{formatCount(count)}</span>
      <span className="sr-only">{formatCount(count)} records</span>
    </span>
  );
}
