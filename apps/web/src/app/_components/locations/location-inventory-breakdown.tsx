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
): HierarchyDrilldownNode => ({
  id: location.id,
  label: location.name,
  metricLabel: formatItems(location.totalItemCount),
  metricValue: location.totalItemCount,
  ...(location.directItemCount > 0
    ? {
        directMetricLabel: formatItems(location.directItemCount),
        directMetricValue: location.directItemCount,
      }
    : {}),
  locationShortcode: location.id,
  ...(location.children.length > 0
    ? { children: location.children.map(buildLocationInventoryBreakdown) }
    : {}),
});

function LocationInventoryBreakdownSkeleton() {
  return (
    <div
      aria-label="Loading contents breakdown"
      className="border-border border-y bg-card px-2 py-2 sm:px-4"
      role="status"
    >
      <Skeleton className="h-3 w-36" />
      <Skeleton className="mt-2 h-11 w-full" />
      <Skeleton className="mt-px h-11 w-full" />
    </div>
  );
}

function LocationInventoryBreakdownError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 border-destructive/40 border-y bg-card px-2 py-2 text-xs sm:px-4">
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

/** A read-only descendant-stock map, kept separate from the editable contents. */
export function LocationInventoryBreakdown({
  shortcode,
  hasChildren,
}: {
  shortcode: LocationInventoryBreakdownOut["id"];
  hasChildren: boolean;
}) {
  const breakdown = useQuery({
    ...location.inventoryBreakdown.queryOptions({ shortcode }),
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
