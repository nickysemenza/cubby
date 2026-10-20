import { formatCurrency } from "~/lib/number-format";
import { KeyNumbers } from "~/ui/common/key-numbers";

interface ExpenseSummary {
  actual: number;
  committed: number;
  credits: number;
  net: number;
  count: number;
}

export function ExpenseSummaryStrip({
  summary,
  basis = "ledger",
  loading = false,
  className,
}: {
  summary?: ExpenseSummary;
  basis?: "ledger" | "allocation";
  loading?: boolean;
  className?: string;
}) {
  const label = (value: string) =>
    basis === "allocation" ? `Allocated ${value.toLowerCase()}` : value;
  const money = (value: number | undefined) =>
    value === undefined ? "Unavailable" : formatCurrency(value);
  const metrics = [
    [label("Actual"), money(summary?.actual)],
    [label("Committed"), money(summary?.committed)],
    [label("Credits"), money(summary?.credits)],
    [label("Net"), money(summary?.net)],
    ["Count", summary?.count ?? "Unavailable"],
  ] as const;

  return (
    <KeyNumbers
      layout="strip"
      label="Spend summary"
      loadingCount={metrics.length}
      items={
        loading
          ? []
          : metrics.map(([label, value]) => ({
              label,
              value,
              money: typeof value === "string" && value !== "Unavailable",
            }))
      }
      className={className}
    />
  );
}
