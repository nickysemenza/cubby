import type { LocationInventoryBreakdownOut } from "@cubby/schemas/location";
import { useQuery } from "@tanstack/react-query";

import {
  HierarchyDrilldown,
  type HierarchyDrilldownNode,
} from "~/app/_components/visualizations/hierarchy-drilldown";
import { location } from "~/app/locations/location.functions";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";

const formatItems = (count: number) =>
  `${count} ${count === 1 ? "item" : "items"}`;

/** A branch is useful only when stock exists below the location itself. */
export const hasDescendantInventory = (
  location: LocationInventoryBreakdownOut | null | undefined,
): location is LocationInventoryBreakdownOut =>
  location !== undefined &&
  location !== null &&
  location.totalItemCount > location.directItemCount;

/**
 * Normalize the lightweight location count tree for the shared local-state
 * drill-down. The API deliberately owns counting; this adapter only makes
 * those counts legible and linkable in the detail UI.
 */
export const buildLocationInventoryBreakdown = (
  location: LocationInventoryBreakdownOut,
): HierarchyDrilldownNode => {
  const node: HierarchyDrilldownNode = {
    id: location.id,
    label: location.name,
    metricLabel: formatItems(location.totalItemCount),
    metricValue: location.totalItemCount,
    locationShortcode: location.id,
  };
  if (location.directItemCount > 0) {
    node.directMetricLabel = formatItems(location.directItemCount);
    node.directMetricValue = location.directItemCount;
  }
  if (location.children.length > 0) {
    node.children = location.children.map(buildLocationInventoryBreakdown);
  }
  return node;
};

function LocationInventoryBreakdownSkeleton() {
  return (
    <output
      aria-label="Loading contents breakdown"
      className="block border-y border-border bg-card px-2 py-2 sm:px-4"
    >
      <Skeleton className="h-3 w-36" />
      <Skeleton className="mt-2 h-11 w-full" />
      <Skeleton className="mt-px h-11 w-full" />
    </output>
  );
}

function LocationInventoryBreakdownError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 border-y border-destructive/40 bg-card px-2 py-2 text-xs sm:px-4">
      <span className="text-muted-foreground">
        Couldn&apos;t load the contents breakdown.
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="min-h-10"
      >
        Retry
      </Button>
    </div>
  );
}

export interface LocationInventoryBreakdownOperations {
  readonly inventoryBreakdown: typeof location.inventoryBreakdown;
}

/** A read-only descendant-stock map, kept separate from the editable contents. */
export function LocationInventoryBreakdown({
  shortcode,
  hasChildren,
  operations = location,
}: {
  shortcode: LocationInventoryBreakdownOut["id"];
  hasChildren: boolean;
  operations?: LocationInventoryBreakdownOperations;
}) {
  const breakdown = useQuery({
    ...operations.inventoryBreakdown.queryOptions({ shortcode }),
    enabled: hasChildren,
  });

  if (!hasChildren) return null;
  if (breakdown.isPending) return <LocationInventoryBreakdownSkeleton />;
  if (breakdown.isError)
    return (
      <LocationInventoryBreakdownError
        onRetry={() => void breakdown.refetch()}
      />
    );

  const root = breakdown.data;
  // A direct-only location has nothing to drill into. This also keeps a stale
  // immediate-children hint from producing an empty chart when a child moved.
  if (!hasDescendantInventory(root)) return null;

  return (
    <HierarchyDrilldown
      root={buildLocationInventoryBreakdown(root)}
      ariaLabel="Contents breakdown"
    />
  );
}
