import { formatCurrency } from "~/lib/number-format";
import { KeyNumbers } from "~/ui/records/key-numbers";

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
    [label("Actual"), money(summary?.actual), true],
    [label("Committed"), money(summary?.committed), true],
    [label("Credits"), money(summary?.credits), true],
    [label("Net"), money(summary?.net), true],
    ["Count", summary?.count ?? "Unavailable", false],
  ] as const;

  return (
    <KeyNumbers
      layout="strip"
      label="Spend summary"
      loadingCount={metrics.length}
      items={
        loading
          ? []
          : metrics.map(([label, value, isMoney]) => ({
              label,
              value,
              money: isMoney && summary !== undefined,
            }))
      }
      className={className}
    />
  );
}
