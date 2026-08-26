import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { ExternalLinkIcon } from "~/app/_components/ExternalLink";
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
import { Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityDetailQueryOptions } from "~/entities/entity-detail.functions";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { purchaseLabel } from "~/lib/purchase-label";
import {
  createProductLinkColumn,
  createProjectLinkColumn,
} from "../_components/data-table/columnHelpers";
import { ListWorkbench } from "../_components/data-table/ListWorkbench";
import { ScopeChip } from "../_components/data-table/ScopeChip";
import { useDeferredFilterOptions } from "../_components/hooks/useDeferredFilterOptions";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  ExpenseBulkActionDialogs,
  useExpenseBulkActions,
} from "../_components/tracker/expense-bulk-actions";
import { useExpenseRowActions } from "../_components/tracker/expense-row-actions";
import { expense } from "./expense.functions";
import {
  createExpenseProductImageColumn,
  ExpenseProductImages,
} from "./expense-product-image-column";
import { ExpenseSummaryStrip } from "./expense-summary-strip";

// Scoped rather than a plain `useNavigate()` so `search` stays typed to this
// route's schema (which is where `productId` is declared) without importing
// the `Route` object itself — that would be circular, since this route file
// renders `ExpenseList`. Same idiom as `expense-analytics-view.tsx`'s
// `route`.
const expensesRoute = getRouteApi("/_authenticated/expenses/");

// Stable empty default — see apps/web/CLAUDE.md's `unstable-hook-default` rule:
// an inline `?? []` would allocate a fresh array every render while the query
// is loading, destabilizing the `useFilterOptions`/`useMemo` chain below it.
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

export function ExpenseList() {
  const columnHelper = useMemo(() => createCubbyColumnHelper<ExpenseOut>(), []);
  const projectOptions = useDeferredFilterOptions("project");
  // Runtime picklist for the manifest's `vendor` spec (optionsKey: "vendor"),
  // ranked by frequency so the most-used vendors sort to the top (the roster
  // comes from `repo/vendor.ts`'s `vendorOptions`, re-exported on this router).
  //
  // The option's VALUE is the vendor id — the manifest's spec is `idMulti` on
  // `vendorId` now, so a name here would be branded into a lie and match
  // nothing. The label is the name, and the count rides in `hint`, NOT the
  // label: the label is what filter chips and the collapsed multi-select
  // summary interpolate, and what the type-ahead matches on.
  const vendorOptions = useDeferredFilterOptions("vendor");
  const expenseBulkActions = useExpenseBulkActions();

  const updateExpenseMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });

  const nameEditable = useNameEditable<ExpenseOut>(
    updateExpenseMutation.mutateAsync,
  );

  const { extraActions, dialogs: rowActionDialogs } = useExpenseRowActions();

  // Runtime picklists for the manifest's `project`/`vendor` specs (optionsKey).
  const projectFilterOptions = useFilterOptions({
    project: projectOptions,
    vendor: vendorOptions,
  });

  // The cost / date / costType / trade / future columns come from the shared
  // factories in `~/app/projects/shared.tsx`, also used by the embedded
  // expenses table on the project detail page — so the two can't drift. This
  // page passes its own mobile projections + filter configs and keeps default
  // cents (no `decimals`); it does pass `signedTone` — this list is the one
  // built to hold refunds and price adjustments (negative expenses are
  // real, not errors), so a credit must render distinctly from a charge, same
  // as product/vendor/purchase/project already do. The project + name + url
  // columns stay inline here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateExpenseMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createExpenseProductImageColumn(columnHelper),
      expenseCostColumn(
        columnHelper,
        async (cost, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { cost },
          });
        },
        {
          mobile: { slot: "trailing", priority: 10, interactive: true },
          signedTone: true,
        },
      ),
      expenseDateColumn(
        columnHelper,
        async (date, expense) => {
          if (date === null) return;
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { date },
          });
        },
        {
          mobile: { slot: "subtitle", priority: 15 },
        },
      ),
      expenseLineKindColumn(
        columnHelper,
        async (lineKind, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { lineKind },
          });
        },
        { mobile: { slot: "meta", priority: 18 } },
      ),
      expenseLineBasisColumn(columnHelper, async (lineBasis, expense) => {
        await updateExpenseMutation.mutateAsync({
          id: expense.id,
          data: { lineBasis },
        });
      }),
      expenseCostTypeColumn(
        columnHelper,
        async (costType, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { costType },
          });
        },
        { mobile: { slot: "meta", priority: 20 } },
      ),
      expenseTradeColumn(
        columnHelper,
        async (trade, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { trade },
          });
        },
        { mobile: { slot: "meta", priority: 60 } },
      ),
      createProjectLinkColumn(columnHelper, {
        className: "w-40",
        mobile: { slot: "meta", priority: 40, interactive: true },
        editable: {
          onSave: async (newProjectId, expense) => {
            await updateExpenseMutation.mutateAsync({
              id: expense.id,
              data: { projectId: newProjectId },
            });
          },
        },
      }),
      createProductLinkColumn(columnHelper, {
        className: "w-40",
        mobile: { slot: "meta", priority: 45, interactive: true },
        editable: {
          onSave: async (newProductId, expense) => {
            await updateExpenseMutation.mutateAsync({
              id: expense.id,
              data: { productId: newProductId },
            });
          },
        },
      }),
      expenseProductQuantityColumn(
        columnHelper,
        async (productQuantity, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { productQuantity },
          });
        },
        {
          mobile: { slot: "meta", priority: 47, interactive: true },
          filterConfig: manifestFilterConfig("expense", "productQuantity"),
        },
      ),
      expenseFutureColumn(
        columnHelper,
        async (future, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { future },
          });
        },
        {
          mobile: { slot: "meta", priority: 50 },
        },
      ),
      // The column keeps the historical `vendor` id and editor/filter wiring,
      // but presents the linked Purchase as the primary accounting relationship.
      expenseVendorColumn(
        columnHelper,
        async (vendor, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { vendor },
          });
        },
        {
          asPurchase: true,
          mobile: { slot: "meta", priority: 70, interactive: true },
        },
      ),
      expenseOrderIdColumn(
        columnHelper,
        async (orderId, expense) => {
          await updateExpenseMutation.mutateAsync({
            id: expense.id,
            data: { orderId },
          });
        },
        { mobile: { slot: "meta", priority: 80 } },
      ),
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
    ],
    [columnHelper],
  );

  // `?productId=` (the product detail page's "See all in ledger" link) scopes
  // the ledger to one product via the manifest's `productId` spec — but no
  // column has that id, so it renders no header control and would otherwise
  // be an invisible-but-active filter with Reset as the only way out. This is
  // its one visible surface: a removable chip showing the resolved product
  // name (never the raw id). `getByID` is the same query every other
  // id→product-name lookup in the app uses (e.g. `ProductPreviewContent`),
  // reused rather than duplicated.
  const expensesSearch = expensesRoute.useSearch();
  const expensesNavigate = expensesRoute.useNavigate();
  const scopedProductId = expensesSearch.productId;
  const hasInvalidProductScope = scopedProductId === UNRESOLVABLE_ENTITY_FILTER;
  const scopedProductQuery = useQuery({
    ...entityDetailQueryOptions("product", scopedProductId ?? ""),
    enabled: Boolean(scopedProductId) && !hasInvalidProductScope,
  });
  const clearProductScope = useCallback(() => {
    void expensesNavigate({
      search: (prev) => ({ ...prev, productId: undefined }),
      replace: true,
    });
  }, [expensesNavigate]);
  const productScopeChip =
    scopedProductId && (hasInvalidProductScope || scopedProductQuery.data) ? (
      <ScopeChip
        name="Product"
        value={scopedProductQuery.data?.name ?? scopedProductId}
        onClear={clearProductScope}
      />
    ) : undefined;

  // `?order=` (the ledger's Order # cell) is the same invisible-filter
  // situation as `?productId=` above — `orderIdExact` has no column, so it needs
  // its own visible surface. No lookup query: the order id IS the display value.
  // It no longer arrives paired with a `vendor` (an order id resolves through
  // the Purchase, where `(vendorId, orderId)` is partial-unique), so clearing it
  // drops `order` and nothing else; a Vendor selection is a real column filter
  // with its own chip.
  const scopedOrderId = expensesSearch.order;
  const clearOrderScope = useCallback(() => {
    void expensesNavigate({
      search: (prev) => ({ ...prev, order: undefined }),
      replace: true,
    });
  }, [expensesNavigate]);
  const orderScopeChip = scopedOrderId ? (
    <ScopeChip name="Order" value={scopedOrderId} onClear={clearOrderScope} />
  ) : undefined;

  // `?purchaseId=` (a deep link from the Purchase detail page) is the same
  // invisible-filter situation as `?productId=` above — the manifest's
  // `purchaseId` spec has no column, so it needs its own visible surface. Like
  // `productScopeChip`, this resolves a display label via a lookup query rather
  // than showing the raw id — `purchaseLabel` over the fetched `PurchaseOut`,
  // the same helper `link-expenses-dialog.tsx` uses for a Purchase's identity.
  const scopedPurchaseId = expensesSearch.purchaseId;
  const hasInvalidPurchaseScope =
    scopedPurchaseId === UNRESOLVABLE_ENTITY_FILTER;
  const scopedPurchaseQuery = useQuery({
    ...entityDetailQueryOptions("purchase", scopedPurchaseId ?? ""),
    enabled: Boolean(scopedPurchaseId) && !hasInvalidPurchaseScope,
  });
  const clearPurchaseScope = useCallback(() => {
    void expensesNavigate({
      search: (prev) => ({ ...prev, purchaseId: undefined }),
      replace: true,
    });
  }, [expensesNavigate]);
  const purchaseScopeChip =
    scopedPurchaseId &&
    (hasInvalidPurchaseScope || scopedPurchaseQuery.data) ? (
      <ScopeChip
        name="Purchase"
        value={
          scopedPurchaseQuery.data
            ? purchaseLabel(scopedPurchaseQuery.data)
            : scopedPurchaseId
        }
        onClear={clearPurchaseScope}
      />
    ) : undefined;

  // Project relationship summaries aggregate descendants. Their deep links
  // carry `?subprojects=true` so the ledger and summary reconcile; expose that
  // otherwise-invisible URL-only scope and let the user narrow back to the
  // selected project without clearing the project itself.
  const includesSubProjects = expensesSearch.subprojects === "true";
  const clearSubProjectsScope = useCallback(() => {
    void expensesNavigate({
      search: (prev) => ({ ...prev, subprojects: undefined }),
      replace: true,
    });
  }, [expensesNavigate]);
  const subProjectsScopeChip = includesSubProjects ? (
    <ScopeChip
      name="Project scope"
      value="Entire subtree"
      onClear={clearSubProjectsScope}
    />
  ) : undefined;

  const scopeChips =
    productScopeChip ||
    orderScopeChip ||
    purchaseScopeChip ||
    subProjectsScopeChip ? (
      <Row align="center" gap="xs">
        {productScopeChip}
        {orderScopeChip}
        {purchaseScopeChip}
        {subProjectsScopeChip}
      </Row>
    ) : undefined;

  const { onRowClick, onRowHover, onRowHoverEnd, PreviewSheet } =
    useEntityPreview("expense");

  // `TFilters` is given explicitly: it can't be inferred from `queryOptions`,
  // whose input is a union with a query skip sentinel, so it would land on
  // `unknown` — and `currentFilters` goes straight to `expense.analytics`,
  // which wants the real shape.
  const { workbench, currentFilters, totalCount, data } = useEntityList<
    ExpenseOut,
    ExpenseFilters
  >({
    entity: "expense",
    filterOptions: projectFilterOptions,
    columns,
    // The expense contract's own list query, delete, and invalidation fan-out.
    deletable: true,
    nameEditable,
    bulkActions: expenseBulkActions.config,
    extraActions,
    // Purchase is visible by default; its Order # detail remains opt-in.
    // `lineBasis` reads "Line item" on all but a handful of rows, so the column
    // is dead weight by default; its header filter is the surface that matters.
    initialColumnVisibility: { orderId: false, lineBasis: false },
  });
  usePageCount(totalCount);

  // `currentFilters` is the ledger query's own filter object — including the
  // URL-only `?productId=` / `?order=` scopes, which never enter the table's
  // column filters. Reusing it (rather than rebuilding from table state) is
  // what keeps this compact totals row reporting on exactly the rows below it.
  const analyticsQuery = useQuery({
    ...expense.analytics.queryOptions(currentFilters),
    placeholderData: keepPreviousData,
  });
  // Facet counts are calculated over the complete server population, never
  // the currently appended infinite pages. Each count omits only its own
  // predicate in `expense.facetCounts`, so alternatives remain meaningful.
  const facetCountsQuery = useQuery({
    ...expense.facetCounts.queryOptions({
      filters: currentFilters,
      facetIds: [...EXPENSE_FACET_IDS],
    }),
    placeholderData: keepPreviousData,
  });
  const facetOptionHints = useMemo(() => {
    // React Query may retain the previous successful payload after a refetch
    // error. Counts are advisory, so hiding them is safer than presenting stale
    // values as if they described the current filter population.
    if (facetCountsQuery.isError) return {};
    const hints: Record<string, Record<string, string>> = {};
    for (const facet of facetCountsQuery.data?.facets ?? []) {
      const columnId =
        FACET_COLUMN_IDS[facet.id as keyof typeof FACET_COLUMN_IDS] ?? facet.id;
      hints[columnId] = Object.fromEntries(
        facet.options.map((option) => [option.value, String(option.count)]),
      );
    }
    return hints;
  }, [facetCountsQuery.data, facetCountsQuery.isError]);
  const summary = analyticsQuery.data?.summary;

  return (
    <div>
      <ExpenseSummaryStrip
        summary={summary}
        adjustmentsNet={analyticsQuery.data?.adjustments.net}
        className="mb-4"
      />
      <ExpenseProductImages rows={data}>
        <ListWorkbench
          model={workbench}
          contextualStatus={scopeChips}
          ariaLabel="Expenses Table"
          onRowClick={onRowClick}
          onRowHover={onRowHover}
          onRowHoverEnd={onRowHoverEnd}
          showCellSelectionStats
          filterOptionHints={facetOptionHints}
          getRowClassName={(row) =>
            row.original.lineKind === "principal"
              ? undefined
              : "bg-[var(--row-zebra)] text-muted-foreground"
          }
        />
      </ExpenseProductImages>
      <PreviewSheet />
      <ExpenseBulkActionDialogs
        controller={expenseBulkActions}
        onComplete={() => workbench.table.resetRowSelection()}
      />
      {rowActionDialogs}
    </div>
  );
}
