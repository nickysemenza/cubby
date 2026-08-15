import { Skeleton } from "~/components/ui/skeleton";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import { formatCurrency } from "~/lib/utils";

interface ExpenseSummary {
  actual: number;
  committed: number;
  credits: number;
  net: number;
  count: number;
}

export function ExpenseSummaryStrip({
  summary,
  adjustmentsNet = 0,
  loading = false,
  className,
}: {
  summary?: ExpenseSummary;
  adjustmentsNet?: number;
  loading?: boolean;
  className?: string;
}) {
  const metrics = [
    ["Actual", formatCurrency(summary?.actual ?? 0, 0)],
    ["Committed", formatCurrency(summary?.committed ?? 0, 0)],
    ["Credits", formatCurrency(summary?.credits ?? 0, 0)],
    ["Net", formatCurrency(summary?.net ?? 0, 0)],
    ["Purchase adjustments", formatCurrency(adjustmentsNet, 0)],
    ["Count", summary?.count ?? 0],
  ] as const;

  return (
    <StatGrid className={className}>
      {metrics.map(([label, value]) =>
        loading ? (
          <Skeleton key={label} className="h-14 w-full" />
        ) : (
          <StatTile key={label} label={label}>
            {value}
          </StatTile>
        ),
      )}
    </StatGrid>
  );
}
