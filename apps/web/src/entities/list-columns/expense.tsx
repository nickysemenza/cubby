import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  createImageColumn,
  createProductLinkColumn,
  createProjectLinkColumn,
  hasDisplayImages,
} from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import { ExternalLinkIcon } from "~/app/_components/ExternalLink";
import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ExpenseSummaryStrip } from "~/app/expenses/expense-summary-strip";
import { expense } from "~/app/expenses/expense.functions";
import {
  expenseCostColumn,
  expenseCostTypeColumn,
  expenseDateColumn,
  expenseFutureColumn,
  expenseLineBasisColumn,
  expenseLineKindColumn,
  expenseOrderIdColumn,
  expenseProductQuantityColumn,
  expenseTradeColumn,
  expenseVendorColumn,
} from "~/app/projects/shared";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListHiddenColumns } from "~/entities/entity-display";
import { relationshipFieldProvenance } from "~/entities/field-provenance";
import { manifestFilterConfig } from "~/entities/filter-manifest";

import { defineListOverride } from "./types";

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
  productPresence: "product",
  orderIdPresence: "orderId",
} as const;

// Purchase is visible by default; its Order # detail remains opt-in, and
// `lineBasis` reads "Line item" on all but a handful of rows.
const EXPENSE_INITIAL_COLUMN_VISIBILITY = entityListHiddenColumns("expense");

const rowClassName = (row: { original: ExpenseOut }) =>
  row.original.lineKind === "principal"
    ? undefined
    : "bg-[var(--row-zebra)] text-muted-foreground";

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
  const analyticsQuery = useQuery({
    ...expense.analytics.queryOptions(filters),
    placeholderData: keepPreviousData,
  });
  return (
    <ExpenseSummaryStrip
      summary={analyticsQuery.data?.summary}
      adjustmentsNet={analyticsQuery.data?.adjustments.net}
      className="mb-4"
    />
  );
}

export const expenseListOverride = defineListOverride<
  ExpenseOut,
  ExpenseFilters
>({
  use() {
    const projectOptions = useDeferredFilterOptions("project");
    // The option's VALUE is the vendor id — the manifest's spec is `idMulti`
    // on `vendorId`; the count rides in `hint`, never the label.
    const vendorOptions = useDeferredFilterOptions("vendor");
    const filterOptions = useFilterOptions({
      project: projectOptions,
      vendor: vendorOptions,
    });

    const updateExpenseMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("expense", "update"),
      entity: "expense",
    });
    // The cost / date / costType / trade / future columns come from the
    // shared factories also used by the embedded expenses table on the
    // project detail page, so the two can't drift. `signedTone`: this list
    // holds refunds and price adjustments, so a credit renders distinctly.
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<ExpenseOut>((add) => {
          add(
            expenseCostColumn(
              columnHelper,
              async (cost, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { cost },
                });
              },
              {
                mobile: { slot: "trailing", priority: 10, interactive: true },
                signedTone: true,
              },
            ),
          );
          add(
            expenseDateColumn(
              columnHelper,
              async (date, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { date },
                });
              },
              { mobile: { slot: "subtitle", priority: 15 } },
            ),
          );
          add(
            expenseLineKindColumn(
              columnHelper,
              async (lineKind, row) => {
                await updateExpenseMutation.mutateAsync(
                  lineKind === "principal"
                    ? { id: row.id, data: { lineKind } }
                    : { id: row.id, data: { lineKind, projectId: null } },
                );
              },
              { mobile: { slot: "meta", priority: 18 } },
            ),
          );
          add(
            expenseLineBasisColumn(columnHelper, async (lineBasis, row) => {
              await updateExpenseMutation.mutateAsync({
                id: row.id,
                data: { lineBasis },
              });
            }),
          );
          add(
            expenseCostTypeColumn(
              columnHelper,
              async (costType, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { costType },
                });
              },
              { mobile: { slot: "meta", priority: 20 } },
            ),
          );
          add(
            expenseTradeColumn(
              columnHelper,
              async (trade, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { trade },
                });
              },
              { mobile: { slot: "meta", priority: 60 } },
            ),
          );
          add(
            createProjectLinkColumn(columnHelper, {
              className: "w-40",
              mobile: { slot: "meta", priority: 40, interactive: true },
              editable: {
                enabled: (row) => row.lineKind === "principal",
                onSave: async (newProjectId, row) => {
                  await updateExpenseMutation.mutateAsync({
                    id: row.id,
                    data: { projectId: newProjectId },
                  });
                },
                suggest: { entity: "expense", field: "projectId" },
              },
            }),
          );
          add(
            createProductLinkColumn(columnHelper, {
              className: "w-40",
              mobile: { slot: "meta", priority: 45, interactive: true },
              editable: {
                onSave: async (newProductId, row) => {
                  await updateExpenseMutation.mutateAsync({
                    id: row.id,
                    data: { productId: newProductId },
                  });
                },
              },
            }),
          );
          add(
            expenseProductQuantityColumn(
              columnHelper,
              async (productQuantity, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { productQuantity },
                });
              },
              {
                mobile: { slot: "meta", priority: 47, interactive: true },
                filterConfig: manifestFilterConfig(
                  "expense",
                  "productQuantity",
                ),
              },
            ),
          );
          add(
            expenseFutureColumn(
              columnHelper,
              async (future, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { future },
                });
              },
              { mobile: { slot: "meta", priority: 50 } },
            ),
          );
          // Keeps the `vendor` id and editor/filter wiring, but presents the
          // linked Purchase as the primary accounting relationship.
          add(
            expenseVendorColumn(
              columnHelper,
              async (vendor, row) => {
                await updateExpenseMutation.mutateAsync({
                  id: row.id,
                  data: { vendor },
                });
              },
              {
                asPurchase: true,
                mobile: { slot: "meta", priority: 70, interactive: true },
              },
            ),
          );
          add(
            expenseOrderIdColumn(
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
          add(
            columnHelper.accessor((row) => row.url, {
              id: "url",
              header: "",
              enableSorting: false,
              meta: { className: "w-10" },
              cell: (info) => {
                const url = info.getValue();
                if (!url) return null;
                return <ExternalLinkIcon href={url} label="Open link" />;
              },
            }),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- updateExpenseMutation changes every render but is functionally stable
      [],
    );

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<ExpenseOut>) =>
        createCubbyColumnCollection<ExpenseOut>((add) => {
          add(
            createImageColumn(columnHelper, {
              entity: "expense",
              provenance: {
                kind: "derived",
                sources: [
                  ...relationshipFieldProvenance("expense", "product").sources,
                  ...relationshipFieldProvenance("expense", "purchase").sources,
                ],
              },
              // The helper stays typed to `ExpenseOut` so it interoperates
              // with the column factories shared with the project page's
              // embedded ledger, whose rows never carry images; this list's
              // rows do.
              getImages: (row) =>
                hasDisplayImages(row) ? row.displayImages : [],
            }),
          );
          declared.visit(add);
        }),
      [],
    );

    const list = useMemo(
      () => ({
        deletable: true as const,
        filterOptions,
        initialColumnVisibility: EXPENSE_INITIAL_COLUMN_VISIBILITY,
      }),
      [filterOptions],
    );

    return {
      overrides,
      compose,
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
