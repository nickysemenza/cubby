import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAllEntityRecords } from "~/entity/hooks/use-all-entity-records";
import { expense } from "~/integrations/tanstack-query/generated/domains/expense.gen";

/** One allocation read plus a bounded ancestry roster; never one report per row. */
export function useCategorySpending<
  E extends "productCategory" | "spendingCategory",
>(entity: E) {
  const input = useMemo(
    () => ({
      filters: {},
      nesting: { scope: "flat" as const },
      pagination: { pageIndex: 0, pageSize: 500 },
    }),
    [],
  );
  const taxonomy = useAllEntityRecords(entity, input);
  const analysisInput = useMemo(
    () => ({
      filters: {},
      rowDimension: entity,
      spendingCategoryRollup: "none" as const,
    }),
    [entity],
  );
  const analysis = useQuery(expense.analyze.queryOptions(analysisInput));
  const totals = useMemo(() => {
    const cents = new Map<string, number>();
    const incomplete = new Set<string>();
    if (
      analysis.data?.status !== "ready" ||
      taxonomy.isLoading ||
      taxonomy.error
    )
      return null;
    const parents = new Map<string, string | null | undefined>(
      taxonomy.records.map((row) => [row.id, row.parentId]),
    );
    for (const cell of analysis.data.cells) {
      // Remainders remain in the report and Ledger, outside the category tree.
      if (cell.rowKey.startsWith("__") || !parents.has(cell.rowKey)) continue;
      const amount = Math.round(cell.current.net * 100);
      const visited = new Set<string>();
      let id: string | null | undefined = cell.rowKey;
      while (id && !visited.has(id)) {
        visited.add(id);
        cents.set(id, (cents.get(id) ?? 0) + amount);
        if (cell.current.unpricedCount > 0) incomplete.add(id);
        id = parents.get(id);
      }
    }
    return { cents, incomplete };
  }, [analysis.data, taxonomy.records, taxonomy.isLoading, taxonomy.error]);
  return {
    totals,
    records: taxonomy.records,
    isLoading: taxonomy.isLoading,
    error: analysis.error ?? taxonomy.error,
    status: analysis.data?.status,
    refetch: analysis.refetch,
  };
}
