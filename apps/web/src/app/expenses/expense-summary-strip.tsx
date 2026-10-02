import { formatCurrency } from "~/lib/utils";
import { Skeleton } from "~/ui/primitives/skeleton";
import { StatGrid, StatTile } from "~/ui/primitives/stat-tile";

interface ExpenseSummary {
  actual: number;
  committed: number;
  credits: number;
  net: number;
  count: number;
}

export function ExpenseSummaryStrip({
  summary,
  adjustmentsNet,
  basis = "ledger",
  loading = false,
  className,
}: {
  summary?: ExpenseSummary;
  basis?: "ledger" | "allocation";
  adjustmentsNet?: number;
  loading?: boolean;
  className?: string;
}) {
  const label = (value: string) =>
    basis === "allocation" ? `Allocated ${value.toLowerCase()}` : value;
  const money = (value: number | undefined) =>
    value === undefined ? "Unavailable" : formatCurrency(value, 0);
  const metrics = [
    [label("Actual"), money(summary?.actual)],
    [label("Committed"), money(summary?.committed)],
    [label("Credits"), money(summary?.credits)],
    [label("Net"), money(summary?.net)],
    ["Purchase adjustments", money(adjustmentsNet)],
    ["Count", summary?.count ?? "Unavailable"],
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
