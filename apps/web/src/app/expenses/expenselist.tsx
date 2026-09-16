import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
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
import { entityDetailFor } from "~/entities/entity-detail.functions";
import {
  createEntityDisplayColumns,
  entityListHiddenColumns,
} from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { purchaseLabel } from "~/lib/purchase-label";

import {
  createImageColumn,
  hasDisplayImages,
  createProductLinkColumn,
  createProjectLinkColumn,
} from "../_components/data-table/columnHelpers";
import { ListWorkbench } from "../_components/data-table/ListWorkbench";
import { ScopeChip } from "../_components/data-table/ScopeChip";
import { useDeferredFilterOptions } from "../_components/hooks/useDeferredFilterOptions";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import type { ListQueryOptionsFn } from "../_components/hooks/usePaginatedTableCore";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { ExpenseSummaryStrip } from "./expense-summary-strip";
import { expense } from "./expense.functions";

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

function useExpenseScopeChips() {
  const search = expensesRoute.useSearch();
  const navigate = expensesRoute.useNavigate();
  const clearScope = useCallback(
    (key: "productId" | "order" | "purchaseId" | "subprojects") => {
      void navigate({
        search: (previous) => ({ ...previous, [key]: undefined }),
        replace: true,
      });
    },
    [navigate],
  );

  const productId = search.productId;
  const invalidProduct = productId === UNRESOLVABLE_ENTITY_FILTER;
  const productQuery = useQuery({
    ...entityDetailFor("product").queryOptions(productId ?? ""),
    enabled: Boolean(productId) && !invalidProduct,
  });
  const productChip =
    productId && (invalidProduct || productQuery.data) ? (
      <ScopeChip
        name="Product"
        value={productQuery.data?.name ?? productId}
        onClear={() => clearScope("productId")}
      />
    ) : undefined;

  const orderChip = search.order ? (
    <ScopeChip
      name="Order"
      value={search.order}
      onClear={() => clearScope("order")}
    />
  ) : undefined;

  const purchaseId = search.purchaseId;
  const invalidPurchase = purchaseId === UNRESOLVABLE_ENTITY_FILTER;
  const purchaseQuery = useQuery({
    ...entityDetailFor("purchase").queryOptions(purchaseId ?? ""),
    enabled: Boolean(purchaseId) && !invalidPurchase,
  });
  const purchaseChip =
    purchaseId && (invalidPurchase || purchaseQuery.data) ? (
      <ScopeChip
        name="Purchase"
        value={
          purchaseQuery.data ? purchaseLabel(purchaseQuery.data) : purchaseId
        }
        onClear={() => clearScope("purchaseId")}
      />
    ) : undefined;

  const subProjectsChip =
    search.subprojects === "true" ? (
      <ScopeChip
        name="Project scope"
        value="Entire subtree"
        onClear={() => clearScope("subprojects")}
      />
    ) : undefined;
  if (!productChip && !orderChip && !purchaseChip && !subProjectsChip) {
    return undefined;
  }
  return (
    <Row align="center" gap="xs">
      {productChip}
      {orderChip}
      {purchaseChip}
      {subProjectsChip}
    </Row>
  );
}

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

  const updateExpenseMutation = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });

  const nameEditable = useNameEditable<ExpenseOut>(
    updateExpenseMutation.mutateAsync,
  );

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
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<ExpenseOut>((add) => {
        add(
          createImageColumn(columnHelper, {
            entity: "expense",
            // This list's ColumnHelper stays typed to the narrower `ExpenseOut`
            // so it interoperates with the cost/date/costType/etc. column
            // factories shared with the project detail page's embedded expense
            // table (`~/app/projects/shared.tsx`'s `ExpenseList`), whose rows
            // come from a chart-data projection that never carries images.
            // This page's own data comes from `entityListFor("expense")`, i.e.
            // `expenseListItemOut` rows, which do carry `displayImages`.
            getImages: (row) =>
              hasDisplayImages(row) ? row.displayImages : [],
          }),
        );
        createEntityDisplayColumns(
          "expense",
          columnHelper,
          createCubbyColumnCollection<ExpenseOut>((add) => {
            add(
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
            );
            add(
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
            );
            add(
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
            );
            add(
              expenseLineBasisColumn(
                columnHelper,
                async (lineBasis, expense) => {
                  await updateExpenseMutation.mutateAsync({
                    id: expense.id,
                    data: { lineBasis },
                  });
                },
              ),
            );
            add(
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
            );
            add(
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
            );
            add(
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
            );
            add(
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
            );
            add(
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
            );
            // The column keeps the historical `vendor` id and editor/filter wiring,
            // but presents the linked Purchase as the primary accounting relationship.
            add(
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
            );
            add(
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
        ).visit(add);
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- updateExpenseMutation changes every render but is functionally stable
    [columnHelper],
  );
  const listQueryOptions = useCallback<
    ListQueryOptionsFn<ExpenseFilters, ExpenseOut>
  >((params) => entityListFor("expense").listQueryPlan(params), []);

  // `?productId=` (the product detail page's "See all in ledger" link) scopes
  // the ledger to one product via the manifest's `productId` spec — but no
  // column has that id, so it renders no header control and would otherwise
  // be an invisible-but-active filter with Reset as the only way out. This is
  // its one visible surface: a removable chip showing the resolved product
  // name (never the raw id). `getByID` is the same query every other
  // id→product-name lookup in the app uses (e.g. `ProductPreviewContent`),
  // reused rather than duplicated.
  const scopeChips = useExpenseScopeChips();

  // `TFilters` is given explicitly: it can't be inferred from `queryOptions`,
  // whose input is a union with a query skip sentinel, so it would land on
  // `unknown` — and `currentFilters` goes straight to `expense.analytics`,
  // which wants the real shape.
  const { workbench, currentFilters, totalCount, inspection } = useEntityList<
    ExpenseOut,
    ExpenseFilters
  >({
    entity: "expense",
    preview: { responsiveInspector: true },
    queryOptions: listQueryOptions,
    filterOptions: projectFilterOptions,
    columns,
    // The expense contract's own list query, delete, and invalidation fan-out.
    deletable: true,
    nameEditable,
    // Purchase is visible by default; its Order # detail remains opt-in.
    // `lineBasis` reads "Line item" on all but a handful of rows, so the column
    // is dead weight by default; its header filter is the surface that matters.
    // Both are declared `display.listHidden` on `16-expense.entity.ts` now.
    initialColumnVisibility: entityListHiddenColumns("expense"),
  });
  const {
    onRowClick,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = inspection;
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
        Object.entries(FACET_COLUMN_IDS).find(([id]) => id === facet.id)?.[1] ??
        facet.id;
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
      <ListWorkbench
        model={workbench}
        contextualStatus={scopeChips}
        ariaLabel="Expenses Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        onRowHoverEnd={onRowHoverEnd}
        currentRowId={preview?.id}
        desktopInspector={dockedInspector}
        inspectorToggle={inspectorToggle}
        showCellSelectionStats
        filterOptionHints={facetOptionHints}
        getRowClassName={(row) =>
          row.original.lineKind === "principal"
            ? undefined
            : "bg-[var(--row-zebra)] text-muted-foreground"
        }
      />
      <PreviewSheet />
    </div>
  );
}
