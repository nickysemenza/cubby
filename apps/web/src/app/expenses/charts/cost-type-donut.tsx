import type { ExpenseCostTypeAggregate } from "@cubby/schemas/project";
import { ShoppingBagIcon as ShoppingBag } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { sumBy } from "es-toolkit";
import { useMemo } from "react";

import { CategoryDonut } from "~/app/_components/charts/kit";
import { capitalize } from "~/app/projects/project-formatting";
import { getCostTypeColor } from "~/lib/status-colors";

/**
 * Cost-type breakdown donut sourced from `expense.analytics`'s `byCostType`
 * aggregate (one grouped SQL sum per cost type) — the analytics-view
 * replacement for `ExpenseDonut`, which summed a raw expense fetch
 * client-side. Same positive-arcs / net-center convention: the ring only
 * draws cost types with positive net (arcs can't render a negative slice),
 * the center label carries the true net across every bucket including
 * negative ones (refunds/credits).
 */
export function CostTypeDonut({
  byCostType,
  height = 300,
  selected,
  onSelect,
}: {
  byCostType: ExpenseCostTypeAggregate[];
  height?: number;
  selected?: string | null;
  onSelect?: (costType: string) => void;
}) {
  const { data, netTotal } = useMemo(() => {
    const data = byCostType
      .filter((row) => row.net > 0)
      .sort((a, b) => b.net - a.net)
      .map((row) => ({
        id: row.costType,
        label: capitalize(row.costType),
        value: row.net,
        color: getCostTypeColor(row.costType),
        count: row.count,
      }));
    const netTotal = sumBy(byCostType, (row) => row.net);
    return { data, netTotal };
  }, [byCostType]);

  return (
    <CategoryDonut
      data={data}
      height={height}
      centerValue={netTotal}
      centerLabel="Net total"
      selectedId={selected}
      onSelect={onSelect}
      renderTooltipExtra={(id) => {
        const count = data.find((d) => d.id === id)?.count ?? 0;
        return (
          <div className="mt-1 text-xs text-muted-foreground">
            {count} expense{count === 1 ? "" : "s"}
          </div>
        );
      }}
      emptyIcon={ShoppingBag}
      emptyTitle="No expense data."
    />
  );
}
