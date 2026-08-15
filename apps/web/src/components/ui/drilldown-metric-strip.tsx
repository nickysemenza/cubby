import type { ReactNode } from "react";
import { Skeleton } from "~/components/ui/skeleton";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import { cn } from "~/lib/utils";

export interface DrilldownMetric {
  label: string;
  value: ReactNode;
  onSelect?: () => void;
  active?: boolean;
}

/** Summary metrics with optional drill-through behavior and one loading shape. */
export function DrilldownMetricStrip({
  metrics,
  loadingCount,
}: {
  metrics?: readonly DrilldownMetric[];
  loadingCount?: number;
}) {
  if (loadingCount) {
    return (
      <StatGrid>
        {Array.from({ length: loadingCount }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </StatGrid>
    );
  }

  return (
    <StatGrid>
      {metrics?.map(({ label, value, onSelect, active }) =>
        onSelect ? (
          <button
            key={label}
            type="button"
            onClick={onSelect}
            aria-current={active || undefined}
            className={cn(
              "min-h-11 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0",
              active && "text-primary",
            )}
          >
            <StatTile label={label}>{value}</StatTile>
          </button>
        ) : (
          <StatTile key={label} label={label}>
            {value}
          </StatTile>
        ),
      )}
    </StatGrid>
  );
}
