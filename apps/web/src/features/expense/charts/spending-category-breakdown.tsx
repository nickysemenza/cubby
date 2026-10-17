import type { ExpenseFilters } from "@cubby/schemas/project";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { expense } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/number-format";
import { RankedBarBreakdown } from "~/ui/charts/kit";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

/** Unresolved buckets read as gaps in the record, not as a category. */
const UNRESOLVED = new Set(["uncategorized", "unclassified"]);

/**
 * Net spend per root Spending Category from `expense.analyze`'s root
 * roll-up, so the bars (Uncategorized and Unclassified included) total the
 * filtered net. A bar opens the Ledger at that bucket's own filter.
 */
export function SpendingCategoryBreakdown({
  filters,
  onOpenLedger,
}: {
  filters: ExpenseFilters;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  const hydrated = useHydrated();
  const query = useQuery(
    expense.analyze.queryOptions({
      filters,
      rowDimension: "spendingCategory",
      spendingCategoryRollup: "root",
      comparison: "none",
    }),
  );
  const data = hydrated ? query.data : undefined;
  const ready = data?.status === "ready" ? data : undefined;
  const rows = useMemo(
    () =>
      ready
        ? ready.rows.map((row) => ({
            key: row.key,
            label: row.label,
            net:
              ready.cells.find((cell) => cell.rowKey === row.key)?.current
                .net ?? 0,
          }))
        : [],
    [ready],
  );
  const filterByKey = useMemo(
    () => new Map(ready?.rows.map((row) => [row.key, row.filter]) ?? []),
    [ready],
  );
  const visualization = visualizationState({
    data,
    isLoading: !hydrated || query.isLoading,
    error: hydrated ? query.error : null,
    empty: rows.length === 0,
    onRetry: () => void query.refetch(),
  });

  if (data?.status === "too_large")
    return (
      <Visualization
        state={{ status: "empty" }}
        message={`Too many categories to chart (over ${data.limit}).`}
      />
    );

  const ranked = [...rows].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const summary = `Net spend by root Spending Category: ${ranked
    .slice(0, 5)
    .map((row) => `${row.label} ${formatCurrency(row.net, 0)}`)
    .join(", ")}`;

  return (
    <Visualization
      state={visualization}
      icon={TagIcon}
      message="No spending to break down."
    >
      <RankedBarBreakdown
        data={rows}
        valueKey="net"
        labelKey="label"
        idKey="key"
        topN={14}
        margin={{ top: 10, right: 40, bottom: 40, left: 180 }}
        color={(row) =>
          row.net < 0
            ? "var(--chart-negative)"
            : UNRESOLVED.has(row.key)
              ? "var(--chart-neutral)"
              : "var(--chart-1)"
        }
        onClick={(row) => {
          const filter = filterByKey.get(row.key);
          if (filter) onOpenLedger(filter);
        }}
        summary={summary}
        emptyIcon={TagIcon}
        emptyTitle="No spending to break down."
      />
    </Visualization>
  );
}
