import type { ExpenseFilters, ExpenseOut } from "@cubby/schemas/project";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, CheckCircle2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
import { VendorMark } from "~/components/entity/vendor-cell";
import { Row } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { manifestFilterConfig } from "~/entities/filter-manifest";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseLabel } from "~/lib/purchase-label";
import { expenseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createProductLinkColumn,
  createProjectLinkColumn,
} from "../_components/data-table/columnHelpers";
import { ScopeChip } from "../_components/data-table/ScopeChip";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  ExpenseBulkActionDialogs,
  useExpenseBulkActions,
} from "../_components/tracker/expense-bulk-actions";
import { MoveToProjectDialog } from "../_components/tracker/move-to-project-dialog";
import {
  createExpenseProductImageColumn,
  ExpenseProductImages,
} from "./expense-product-image-column";
import { ExpenseSummaryStrip } from "./expense-summary-strip";
import { SettleExpenseDialog } from "./settle-expense-dialog";

// Scoped rather than a plain `useNavigate()` so `search` stays typed to this
// route's schema (which is where `productId` is declared) without importing
// the `Route` object itself — that would be circular, since this route file
// renders `ExpenseList`. Same idiom as `expense-analytics-view.tsx`'s
// `route`.
const expensesRoute = getRouteApi("/_authenticated/expenses/");

// Stable empty default — see apps/web/CLAUDE.md's `unstable-hook-default` rule:
// an inline `?? []` would allocate a fresh array every render while the query
// is loading, destabilizing the `useFilterOptions`/`useMemo` chain below it.
const NO_VENDOR_OPTIONS: FilterableComboboxItem[] = [];

export function ExpenseList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<ExpenseOut>(), []);
  const { options: projectOptions } = useProjectOptions();
  // Runtime picklist for the manifest's `vendor` spec (optionsKey: "vendor"),
  // ranked by frequency so the most-used vendors sort to the top (the roster
  // comes from `repo/vendor.ts`'s `vendorOptions`, re-exported on this router).
  //
  // The option's VALUE is the vendor id — the manifest's spec is `idMulti` on
  // `vendorId` now, so a name here would be branded into a lie and match
  // nothing. The label is the name, and the count rides in `hint`, NOT the
  // label: the label is what filter chips and the collapsed multi-select
  // summary interpolate, and what the type-ahead matches on.
  const vendorOptionsQuery = useQuery(api.expense.vendorOptions.queryOptions());
  const vendorOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      vendorOptionsQuery.data?.map(({ id, name, count }) => ({
        value: id,
        label: name,
        hint: String(count),
        icon: <VendorMark vendor={name} vendorId={id} />,
      })) ?? NO_VENDOR_OPTIONS,
    [vendorOptionsQuery.data],
  );
  const expenseBulkActions = useExpenseBulkActions();
  const [moveTarget, setMoveTarget] = useState<ExpenseOut | null>(null);
  const [settleTarget, setSettleTarget] = useState<ExpenseOut | null>(null);

  const updateExpenseMutation = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });

  const nameEditable = useNameEditable<ExpenseOut>(
    updateExpenseMutation.mutateAsync,
  );

  const deletableConfig = useDeletableConfig({
    mutationFn: api.expense.delete.mutationOptions,
    entityLabel: "Expense",
    invalidateKeys: expenseMutationInvalidateKeys,
    entity: "expense",
  });

  const moveMutation = useUpdateMutation({
    mutationFn: api.expense.update.mutationOptions,
    entity: "expense",
    invalidateKeys: expenseMutationInvalidateKeys,
  });

  // Settle a planned expense without leaving the table, and move a single one
  // to a project. Reschedule / change-estimate aren't duplicated here — the
  // Date and Cost columns are already inline-editable.
  //
  // Keyed on the ROW, not the view: "mark purchased" / "move to project" are
  // meaningful for any planned expense, whichever filters got you to it.
  // They used to be gated on the `planned` tab, which meant the same row
  // offered different actions depending on how you'd navigated to it.
  const extraActions = useCallback(
    (row: ExpenseOut) =>
      row.future ? (
        <>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              setSettleTarget(row);
            }}
          >
            <CheckCircle2 />
            Mark purchased
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              setMoveTarget(row);
            }}
          >
            <ArrowRightLeft />
            Move to project...
          </DropdownMenuItem>
        </>
      ) : null,
    [],
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
  // built to hold refunds and family contributions (negative expenses are
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
  const scopedProductQuery = useQuery({
    ...api.product.getByID.queryOptions({ id: scopedProductId ?? "" }),
    enabled: Boolean(scopedProductId),
  });
  const clearProductScope = useCallback(() => {
    void expensesNavigate({
      search: (prev) => ({ ...prev, productId: undefined }),
      replace: true,
    });
  }, [expensesNavigate]);
  const productScopeChip =
    scopedProductId && scopedProductQuery.data ? (
      <ScopeChip
        name="Product"
        value={scopedProductQuery.data.name}
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
  const scopedPurchaseQuery = useQuery({
    ...api.purchase.getByID.queryOptions({ id: scopedPurchaseId ?? "" }),
    enabled: Boolean(scopedPurchaseId),
  });
  const clearPurchaseScope = useCallback(() => {
    void expensesNavigate({
      search: (prev) => ({ ...prev, purchaseId: undefined }),
      replace: true,
    });
  }, [expensesNavigate]);
  const purchaseScopeChip =
    scopedPurchaseId && scopedPurchaseQuery.data ? (
      <ScopeChip
        name="Purchase"
        value={purchaseLabel(scopedPurchaseQuery.data)}
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

  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("expense");

  // `TFilters` is given explicitly: it can't be inferred from `queryOptions`,
  // whose input is a union with tRPC's `skipToken` symbol, so it would land on
  // `unknown` — and `currentFilters` goes straight to `expense.analytics`,
  // which wants the real shape.
  const {
    table,
    currentFilters,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    totalCount,
    data,
  } = useEntityList<ExpenseOut, ExpenseFilters>({
    entity: "expense",
    queryOptions: api.expense.list.queryOptions,
    filterOptions: projectFilterOptions,
    columns,
    deletable: deletableConfig,
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
    ...api.expense.analytics.queryOptions(currentFilters),
    placeholderData: keepPreviousData,
  });
  const summary = analyticsQuery.data?.summary;

  return (
    <div>
      <ExpenseSummaryStrip
        summary={summary}
        adjustmentsNet={analyticsQuery.data?.adjustments.net}
        className="mb-4"
      />
      <ExpenseProductImages rows={data}>
        <RTable
          table={table}
          additionalToolbarContent={scopeChips}
          isLoading={isLoading}
          error={error}
          ariaLabel="Expenses Table"
          timing={timing}
          entity="expense"
          onRowClick={onRowClick}
          onRowHover={onRowHover}
          bulkActionBar={bulkActionBar}
          infiniteScroll={infiniteScroll}
          refreshControls={refreshControls}
          getRowClassName={(row) =>
            row.original.lineKind === "principal"
              ? undefined
              : "bg-[var(--row-zebra)] text-muted-foreground"
          }
        />
      </ExpenseProductImages>
      <PreviewSheet />
      {deleteDialog}
      <ExpenseBulkActionDialogs
        controller={expenseBulkActions}
        onComplete={() => table.resetRowSelection()}
      />
      {moveTarget && (
        <MoveToProjectDialog
          open={moveTarget !== null}
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null);
          }}
          items={[moveTarget]}
          entityLabel="Expense"
          isPending={moveMutation.isPending}
          onConfirm={async (projectId) => {
            await moveMutation.mutateAsync({
              id: moveTarget.id,
              data: { projectId },
            });
            setMoveTarget(null);
          }}
        />
      )}
      {settleTarget && (
        <SettleExpenseDialog
          open={settleTarget !== null}
          onOpenChange={(open) => {
            if (!open) setSettleTarget(null);
          }}
          expense={settleTarget}
        />
      )}
    </div>
  );
}
