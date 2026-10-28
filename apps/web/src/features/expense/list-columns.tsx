import { fieldDecisionOf } from "@cubby/schemas/field-envelope";
import type { ExpenseFilters } from "@cubby/schemas/project";
import { useQueryClient } from "@tanstack/react-query";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { ListRowOf } from "~/entity/display/list-renderer-types";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { useUpdateMutation } from "~/entity/hooks/use-update-mutation";
import { useEntityMetadata } from "~/entity/metadata";
import { ExpenseSummaryStrip } from "~/features/expense/expense-summary-strip";
import {
  expenseOrderIdColumn,
  expenseVendorColumn,
} from "~/features/project/shared";
import { expense } from "~/integrations/tanstack-query/generated/domains/expense.gen";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/ui/data-table/table-features";

import { defineListOverride } from "../../entity/list-columns/types";

const columnHelper = createCubbyColumnHelper<ExpenseOut>();

const EXPENSE_FACET_IDS = [
  "costType",
  "lineKind",
  "lineBasis",
  "trade",
  "future",
  "project",
  "productPresence",
  "vendor",
  "orderIdPresence",
] as const;

const FACET_COLUMN_IDS = {
  project: "projectId",
  productPresence: "productId",
  vendor: "purchaseId",
  orderIdPresence: "orderId",
} as const;

const rowClassName = (row: { original: ExpenseOut }) =>
  fieldDecisionOf(row.original.fields.projectId)?.provenance?.kind ===
  "allocated"
    ? "bg-[var(--row-zebra)] text-muted-foreground"
    : undefined;

/**
 * Facet counts are calculated over the complete server population, never the
 * appended infinite pages; each count omits only its own predicate so the
 * alternatives remain meaningful.
 */
function useExpenseFacetHints(filters: ExpenseFilters) {
  const facetCountsQuery = useQuery({
    ...expense.facetCounts.queryOptions({
      filters,
      facetIds: [...EXPENSE_FACET_IDS],
    }),
    placeholderData: keepPreviousData,
  });
  return useMemo(() => {
    // Counts are advisory, so stale values after a refetch error are hidden
    // rather than presented as the current population.
    if (facetCountsQuery.isError) return {};
    const hints: Record<string, Record<string, string>> = {};
    for (const facet of facetCountsQuery.data?.facets ?? []) {
      const columnId =
        Object.entries(FACET_COLUMN_IDS).find(([id]) => id === facet.id)?.[1] ??
        facet.id;
      hints[columnId] = Object.fromEntries(
        facet.options.map((option) => [option.value, String(option.count)]),
      );
    }
    return hints;
  }, [facetCountsQuery.data, facetCountsQuery.isError]);
}

/**
 * `currentFilters` is the ledger query's own filter object — including the
 * URL-only scopes that never enter the table's column filters — so the totals
 * row reports on exactly the rows below it.
 */
function ExpenseLedgerSummary({ filters }: { filters: ExpenseFilters }) {
  const summaryQuery = useQuery({
    ...expense.spendSummary.queryOptions(filters),
    placeholderData: keepPreviousData,
  });
  return (
    <ExpenseSummaryStrip
      basis={
        filters.projectId || filters.projectPresenceFilter
          ? "allocation"
          : "ledger"
      }
      loading={summaryQuery.isPending || summaryQuery.isPlaceholderData}
      summary={summaryQuery.isPlaceholderData ? undefined : summaryQuery.data}
      className="mb-4"
    />
  );
}

export const expenseListOverride = defineListOverride<
  ExpenseOut,
  ExpenseFilters
>({
  use() {
    const queryClient = useQueryClient();
    useEntityMetadata("expense");
    const updateExpenseMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("expense", "update"),
      entity: "expense",
    });
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<ExpenseOut>((add) => {
          // Keeps the `vendor` id and editor/filter wiring, but presents the
          // linked Purchase as the primary accounting relationship.
          add(
            expenseVendorColumn(
              queryClient,
              columnHelper,
              async (vendor, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { vendor },
                });
              },
              {
                id: "purchaseId",
                asPurchase: true,
                mobile: { slot: "meta", priority: 70, interactive: true },
              },
            ),
          );
          add(
            expenseOrderIdColumn(
              queryClient,
              columnHelper,
              async (orderId, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { orderId },
                });
              },
              { mobile: { slot: "meta", priority: 80 } },
            ),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- updateExpenseMutation changes every render but is functionally stable
      [queryClient],
    );

    const list = useMemo(
      () => ({
        deletable: true as const,
      }),
      [],
    );

    return {
      overrides,
      list,
      above: ({ currentFilters }) => (
        <ExpenseLedgerSummary filters={currentFilters} />
      ),
      useWorkbench: ({ currentFilters }) => ({
        filterOptionHints: useExpenseFacetHints(currentFilters),
        showCellSelectionStats: true,
        getRowClassName: rowClassName,
      }),
    };
  },
});

type ExpenseOut = ListRowOf<"expense">;
