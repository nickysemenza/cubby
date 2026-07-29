import type { PurchaseOut } from "@cubby/schemas/project";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft, CheckCircle2, ExternalLink } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  purchaseCostColumn,
  purchaseCostTypeColumn,
  purchaseDateColumn,
  purchaseFutureColumn,
  purchaseOrderIdColumn,
  purchaseTradeColumn,
  purchaseVendorColumn,
} from "~/app/projects/shared";
import { VendorMark } from "~/components/entity/vendor-cell";
import { Grid } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { StatTile } from "~/components/ui/stat-tile";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromColumnFilters,
} from "~/entities/filters";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { formatCurrency } from "~/lib/utils";
import { ScopeChip } from "../_components/data-table/ActiveFilterChips";
import {
  createProductLinkColumn,
  createProjectLinkColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { MoveToProjectDialog } from "../_components/tracker/move-to-project-dialog";
import {
  PurchaseBulkActionDialogs,
  usePurchaseBulkActions,
} from "../_components/tracker/purchase-bulk-actions";
import { SettlePurchaseDialog } from "./settle-purchase-dialog";

// Scoped rather than a plain `useNavigate()` so `search` stays typed to this
// route's schema (which is where `productId` is declared) without importing
// the `Route` object itself — that would be circular, since this route file
// renders `PurchaseList`. Same idiom as `purchase-analytics-view.tsx`'s
// `route`.
const purchasesRoute = getRouteApi("/_authenticated/purchases/");

// Stable empty default — see apps/web/CLAUDE.md's `unstable-hook-default` rule:
// an inline `?? []` would allocate a fresh array every render while the query
// is loading, destabilizing the `useFilterOptions`/`useMemo` chain below it.
const NO_VENDOR_OPTIONS: FilterableComboboxItem[] = [];

export function PurchaseList() {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<PurchaseOut>(), []);
  const { options: projectOptions } = useProjectOptions();
  // Runtime picklist for the manifest's `vendor` spec (optionsKey: "vendor"),
  // ranked by frequency so the most-used vendors sort to the top (see
  // `purchaseVendorOptions`). The count rides in `hint`, NOT the label: the
  // label is what filter chips and the collapsed multi-select summary
  // interpolate, and what the type-ahead matches on.
  const vendorOptionsQuery = useQuery(
    api.purchase.vendorOptions.queryOptions(),
  );
  const vendorOptions = useMemo<FilterableComboboxItem[]>(
    () =>
      vendorOptionsQuery.data?.map(({ vendor, count }) => ({
        value: vendor,
        label: vendor,
        hint: String(count),
        icon: <VendorMark vendor={vendor} />,
      })) ?? NO_VENDOR_OPTIONS,
    [vendorOptionsQuery.data],
  );
  const purchaseBulkActions = usePurchaseBulkActions();
  const [moveTarget, setMoveTarget] = useState<PurchaseOut | null>(null);
  const [settleTarget, setSettleTarget] = useState<PurchaseOut | null>(null);

  const updatePurchaseMutation = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  const nameEditable = useNameEditable<PurchaseOut>(
    updatePurchaseMutation.mutateAsync,
  );

  const deletableConfig = useDeletableConfig({
    mutationFn: api.purchase.delete.mutationOptions,
    entityLabel: "Purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  const moveMutation = useUpdateMutation({
    mutationFn: api.purchase.update.mutationOptions,
    entity: "purchase",
    invalidateKeys: purchaseMutationInvalidateKeys,
  });

  // Settle a planned purchase without leaving the table, and move a single one
  // to a project. Reschedule / change-estimate aren't duplicated here — the
  // Date and Cost columns are already inline-editable.
  //
  // Keyed on the ROW, not the view: "mark purchased" / "move to project" are
  // meaningful for any planned purchase, whichever filters got you to it.
  // They used to be gated on the `planned` tab, which meant the same row
  // offered different actions depending on how you'd navigated to it.
  const extraActions = useCallback(
    (row: PurchaseOut) =>
      row.future ? (
        <>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              setSettleTarget(row);
            }}
          >
            <CheckCircle2 className="mr-2 size-4" />
            Mark purchased
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              setMoveTarget(row);
            }}
          >
            <ArrowRightLeft className="mr-2 size-4" />
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
  // purchases table on the project detail page — so the two can't drift. This
  // page passes its own mobile projections + filter configs and keeps default
  // cents (no `decimals`/`signedTone`); the project + name + url columns stay
  // inline here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updatePurchaseMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      purchaseCostColumn(
        columnHelper,
        async (cost, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { cost },
          });
        },
        { mobile: { slot: "trailing", priority: 10, interactive: true } },
      ),
      purchaseDateColumn(
        columnHelper,
        async (date, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { date },
          });
        },
        {
          mobile: { slot: "subtitle", priority: 15 },
        },
      ),
      purchaseCostTypeColumn(
        columnHelper,
        async (costType, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { costType },
          });
        },
        { mobile: { slot: "meta", priority: 20 } },
      ),
      purchaseTradeColumn(
        columnHelper,
        async (trade, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { trade },
          });
        },
        { mobile: { slot: "meta", priority: 60 } },
      ),
      createProjectLinkColumn(columnHelper, {
        className: "w-40",
        mobile: { slot: "meta", priority: 40, interactive: true },
        editable: {
          onSave: async (newProjectId, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { projectId: newProjectId },
            });
          },
        },
      }),
      createProductLinkColumn(columnHelper, {
        className: "w-40",
        mobile: { slot: "meta", priority: 45, interactive: true },
        editable: {
          onSave: async (newProductId, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { productId: newProductId },
            });
          },
        },
      }),
      purchaseFutureColumn(
        columnHelper,
        async (future, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { future },
          });
        },
        {
          mobile: { slot: "meta", priority: 50 },
        },
      ),
      // Hidden by default (see `initialColumnVisibility` below) — revealed via
      // the column-visibility toggle when a vendor-heavy view (e.g. an Amazon
      // reconciliation pass) actually wants them.
      purchaseVendorColumn(
        columnHelper,
        async (vendor, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
            data: { vendor },
          });
        },
        { mobile: { slot: "meta", priority: 70 } },
      ),
      purchaseOrderIdColumn(
        columnHelper,
        async (orderId, purchase) => {
          await updatePurchaseMutation.mutateAsync({
            id: purchase.id,
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
          return (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-muted-foreground transition-colors hover:text-primary"
            >
              <ExternalLink className="size-3.5" />
              <span className="sr-only">Open link</span>
            </a>
          );
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
  const purchasesSearch = purchasesRoute.useSearch();
  const purchasesNavigate = purchasesRoute.useNavigate();
  const scopedProductId = purchasesSearch.productId;
  const scopedProductQuery = useQuery({
    ...api.product.getByID.queryOptions({ id: scopedProductId ?? "" }),
    enabled: Boolean(scopedProductId),
  });
  const clearProductScope = useCallback(() => {
    void purchasesNavigate({
      search: (prev) => ({ ...prev, productId: undefined }),
      replace: true,
    });
  }, [purchasesNavigate]);
  const productScopeChip =
    scopedProductId && scopedProductQuery.data ? (
      <ScopeChip
        name="Product"
        value={scopedProductQuery.data.name}
        onClear={clearProductScope}
      />
    ) : undefined;

  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("purchase");

  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    totalCount,
  } = useEntityList({
    entity: "purchase",
    queryOptions: api.purchase.list.queryOptions,
    filterOptions: projectFilterOptions,
    columns,
    deletable: deletableConfig,
    nameEditable,
    bulkActions: purchaseBulkActions.config,
    extraActions,
    // Newly added columns default VISIBLE unless declared here (see
    // useTableColumnVisibility's `{ ...initial, ...stored }` merge) — vendor
    // and order id are niche enough (mostly an Amazon-reconciliation need) to
    // stay opt-in via the column toggle rather than clutter the default view.
    initialColumnVisibility: { vendor: false, orderId: false },
  });
  usePageCount(totalCount);

  // Mirror the table's active filters into `PurchaseFilters` — drives the
  // ledger's compact totals row (`purchase.analytics`) below.
  const columnFilters = table.getState().columnFilters;
  const currentFilters = useMemo(
    () =>
      buildFiltersFromManifest(
        getEntityFilters("purchase"),
        filterGetterFromColumnFilters(columnFilters),
      ),
    [columnFilters],
  );

  const analyticsQuery = useQuery({
    ...api.purchase.analytics.queryOptions(currentFilters),
    placeholderData: keepPreviousData,
  });
  const summary = analyticsQuery.data?.summary;

  return (
    <div>
      <Grid cols="summary" className="mb-4">
        <StatTile label="Actual">
          {formatCurrency(summary?.actual ?? 0, 0)}
        </StatTile>
        <StatTile label="Committed">
          {formatCurrency(summary?.committed ?? 0, 0)}
        </StatTile>
        <StatTile label="Credits">
          {formatCurrency(summary?.credits ?? 0, 0)}
        </StatTile>
        <StatTile label="Net">{formatCurrency(summary?.net ?? 0, 0)}</StatTile>
        <StatTile label="Count">{summary?.count ?? 0}</StatTile>
      </Grid>
      <RTable
        table={table}
        additionalToolbarContent={productScopeChip}
        isLoading={isLoading}
        error={error}
        ariaLabel="Purchases Table"
        timing={timing}
        entity="purchase"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
      {deleteDialog}
      <PurchaseBulkActionDialogs
        controller={purchaseBulkActions}
        onComplete={() => table.resetRowSelection()}
      />
      {moveTarget && (
        <MoveToProjectDialog
          open={moveTarget !== null}
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null);
          }}
          items={[moveTarget]}
          entityLabel="Purchase"
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
        <SettlePurchaseDialog
          open={settleTarget !== null}
          onOpenChange={(open) => {
            if (!open) setSettleTarget(null);
          }}
          purchase={settleTarget}
        />
      )}
    </div>
  );
}
