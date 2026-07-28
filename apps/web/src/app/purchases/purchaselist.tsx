import type {
  CostType,
  PurchaseFilters,
  PurchaseOut,
  Trade,
} from "@cubby/schemas/project";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { ColumnFiltersState, Row } from "@tanstack/react-table";
import { createColumnHelper } from "@tanstack/react-table";
import {
  ArrowRightLeft,
  CheckCircle2,
  ExternalLink,
  Tag,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  purchaseCostColumn,
  purchaseCostTypeColumn,
  purchaseDateColumn,
  purchaseFutureColumn,
  purchaseTradeColumn,
  tradeOptions,
} from "~/app/projects/shared";
import { Grid } from "~/components/layout";
import { usePageCount } from "~/components/page/Page";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { StatTile } from "~/components/ui/stat-tile";
import { getEntityFilters } from "~/entities/filter-manifest";
import { buildFiltersFromManifest } from "~/entities/filters";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { formatCurrency } from "~/lib/utils";
import {
  createProductLinkColumn,
  createProjectLinkColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useActionMutation } from "../_components/hooks/useActionMutation";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { MoveToProjectDialog } from "../_components/tracker/move-to-project-dialog";
import { SetFieldDialog } from "../_components/tracker/set-field-dialog";
import { costTypeOptions } from "./purchase-options";
import { SettlePurchaseDialog } from "./settle-purchase-dialog";

const route = getRouteApi("/_authenticated/purchases/");

interface PurchaseListProps {
  /**
   * `ledger` (default): the full URL-backed filter set, plus a compact
   * totals row and the analytics-view URL bridge (see the effect below).
   * `planned`: preset to `future: true`, sorted by date ascending (undated
   * last — Postgres's default NULLS LAST ordering, no extra sort logic
   * needed). `unclassified`: preset to the `trade='other' AND cost IS NULL`
   * predicate via `costIsNull`.
   */
  mode?: "ledger" | "planned" | "unclassified";
  /**
   * Seed the "name" column filter from the route's `q` search param (e.g. a
   * command-palette deep link). Only used on mount for `planned`/
   * `unclassified` — the `ledger` mode instead seeds (and live-syncs) from
   * the full URL filter set below.
   */
  initialSearch?: string;
}

export function PurchaseList({
  mode = "ledger",
  initialSearch,
}: PurchaseListProps) {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<PurchaseOut>(), []);
  const { options: projectOptions } = useProjectOptions();
  const [bulkMoveItems, setBulkMoveItems] = useState<PurchaseOut[]>([]);
  const [bulkTradeItems, setBulkTradeItems] = useState<PurchaseOut[]>([]);
  const [bulkCostTypeItems, setBulkCostTypeItems] = useState<PurchaseOut[]>([]);
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

  // Planned-view-only row action: settle a planned purchase without leaving
  // the table, and move a single planned purchase to a project. Reschedule /
  // change-estimate quick edits aren't duplicated here — the Date and Cost
  // columns below are already inline-editable (`purchaseDateColumn` /
  // `purchaseCostColumn`), which IS "the inline-edit pattern the codebase
  // already has" for those two fields.
  const extraActions = useCallback(
    (row: PurchaseOut) =>
      mode === "planned" ? (
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
    [mode],
  );

  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move to project...",
          icon: <ArrowRightLeft className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<PurchaseOut>[]) => {
            setBulkMoveItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-trade",
          label: "Set trade...",
          icon: <Wrench className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<PurchaseOut>[]) => {
            setBulkTradeItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
        {
          id: "set-cost-type",
          label: "Set cost type...",
          icon: <Tag className="size-4" />,
          minSelection: 1,
          onExecute: async (rows: Row<PurchaseOut>[]) => {
            setBulkCostTypeItems(rows.map((r) => r.original));
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  // Runtime picklist for the manifest's `project` spec (optionsKey: "project").
  const projectFilterOptions = useMemo(
    () => ({ project: projectOptions }),
    [projectOptions],
  );

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

  // `future` is fixed for the planned preset, `trade` is fixed for the
  // unclassified preset — dropping their filter dropdowns (the columns stay,
  // still inline-editable) avoids a filter control that can never do anything.
  // Ledger-only: seed initial column filters from the URL (mount-only, mirrors
  // useSeededFilter) so a chart-driven trade/costType click, or a bookmarked/
  // shared link, restores the same rows. `planned`/`unclassified` stay on the
  // simpler single-field `initialSearch` seed — their trade/future dimensions
  // are pinned by `presetFilters`, not user-filterable via the URL.
  const urlSearch = route.useSearch();
  const navigate = route.useNavigate();
  const [ledgerInitialFilter] = useState<ColumnFiltersState>(() => {
    if (mode !== "ledger") return [];
    const entries: Array<[string, string | undefined]> = [
      ["name", urlSearch.q],
      ["trade", urlSearch.trade],
      ["costType", urlSearch.costType],
      ["project", urlSearch.project],
      ["future", urlSearch.future],
      ["date", urlSearch.date],
      ["productId", urlSearch.productId],
      ["product", urlSearch.product],
    ];
    return entries
      .filter((e): e is [string, string] => e[1] !== undefined)
      .map(([id, value]) => ({ id, value }));
  });
  const seededFilter = useSeededFilter(
    "name",
    mode === "ledger" ? undefined : initialSearch,
  );
  // Stable reference — useEntityList/useTableState treat this as hook config,
  // not render-time data (see the CLAUDE.md rule against inline objects on
  // hooks with dependencies).
  const tableStateOptions = useMemo(
    () =>
      mode === "ledger" ? { initialFilter: ledgerInitialFilter } : seededFilter,
    [mode, ledgerInitialFilter, seededFilter],
  );

  const presetFilters = useMemo((): Partial<PurchaseFilters> => {
    if (mode === "planned") return { future: true };
    if (mode === "unclassified") return { trade: "other", costIsNull: true };
    return {};
  }, [mode]);

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
    extraFilters: presetFilters,
    filterOptions: projectFilterOptions,
    columns,
    deletable: deletableConfig,
    nameEditable,
    bulkActions,
    extraActions,
    infinite: true,
    tableStateOptions,
  });
  usePageCount(totalCount);

  // Planned view defaults to expected-date ascending (undated last, via
  // Postgres's NULLS LAST default — see `database-helpers/query.ts`) instead
  // of the table's usual "newest first". Runs once on mount; a user re-sort
  // afterwards is left alone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only by design, `table` is intentionally excluded
  useEffect(() => {
    if (mode === "planned") {
      table.setSorting([{ id: "date", desc: false }]);
    }
  }, [mode]);

  const bulkMoveMutation = useActionMutation({
    mutationFn: api.purchase.bulkMove.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Moved ${data.items.length} purchase${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkMoveItems([]);
      table.resetRowSelection();
    },
  });

  const bulkTradeMutation = useActionMutation({
    mutationFn: api.purchase.bulkSetTrade.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} purchase${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkTradeItems([]);
      table.resetRowSelection();
    },
  });

  const bulkCostTypeMutation = useActionMutation({
    mutationFn: api.purchase.bulkSetCostType.mutationOptions,
    invalidateKeys: purchaseMutationInvalidateKeys,
    success: (data) =>
      savedWithBackgroundWork(
        data.sideEffects,
        `Updated ${data.items.length} purchase${data.items.length !== 1 ? "s" : ""}`,
      ),
    onSuccess: () => {
      setBulkCostTypeItems([]);
      table.resetRowSelection();
    },
  });

  // Mirror the table's active filters into `PurchaseFilters` — drives the
  // ledger's compact totals row (`purchase.analytics`) below.
  const columnFilters = table.getState().columnFilters;
  const currentFilters = useMemo(
    () => ({
      ...buildFiltersFromManifest(
        getEntityFilters("purchase"),
        (id) => columnFilters.find((f) => f.id === id)?.value as string,
      ),
      ...presetFilters,
    }),
    [columnFilters, presetFilters],
  );

  // Ledger-only: push the trade/costType/project/future/date/name column
  // filters back into the URL as they change, so the Analytics view's
  // matrix-cell click (which writes these same params) and this table always
  // agree on "the current filters" in both directions.
  const lastWrittenFilters = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== "ledger") return;
    const get = (id: string) =>
      columnFilters.find((f) => f.id === id)?.value as string | undefined;
    const next = {
      q: get("name"),
      trade: get("trade") as Trade | undefined,
      costType: get("costType") as CostType | undefined,
      project: get("project"),
      future: get("future") as "true" | "false" | undefined,
      date: get("date"),
      productId: get("productId"),
      product: get("product") as "has" | "none" | undefined,
    };
    const serialized = JSON.stringify(next);
    if (lastWrittenFilters.current === serialized) return;
    lastWrittenFilters.current = serialized;
    void navigate({
      search: (prev) => ({ ...prev, ...next }),
      replace: true,
    });
  }, [mode, columnFilters, navigate]);

  const analyticsQuery = useQuery({
    ...api.purchase.analytics.queryOptions(currentFilters),
    enabled: mode === "ledger",
    placeholderData: keepPreviousData,
  });
  const summary = analyticsQuery.data?.summary;

  return (
    <div>
      {mode === "ledger" && (
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
          <StatTile label="Net">
            {formatCurrency(summary?.net ?? 0, 0)}
          </StatTile>
          <StatTile label="Count">{summary?.count ?? 0}</StatTile>
        </Grid>
      )}
      <RTable
        table={table}
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
      {bulkMoveItems.length > 0 && (
        <MoveToProjectDialog
          open={bulkMoveItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkMoveItems([]);
          }}
          items={bulkMoveItems}
          entityLabel="Purchase"
          isPending={bulkMoveMutation.isPending}
          onConfirm={async (projectId) => {
            await bulkMoveMutation.mutateAsync({
              ids: bulkMoveItems.map((p) => p.id),
              projectId,
            });
          }}
        />
      )}
      {bulkTradeItems.length > 0 && (
        <SetFieldDialog
          open={bulkTradeItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkTradeItems([]);
          }}
          items={bulkTradeItems}
          isPending={bulkTradeMutation.isPending}
          options={tradeOptions}
          fieldLabel="Trade"
          itemNoun="Purchase"
          onConfirm={async (trade) => {
            await bulkTradeMutation.mutateAsync({
              ids: bulkTradeItems.map((p) => p.id),
              trade: trade as Trade,
            });
          }}
        />
      )}
      {bulkCostTypeItems.length > 0 && (
        <SetFieldDialog
          open={bulkCostTypeItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkCostTypeItems([]);
          }}
          items={bulkCostTypeItems}
          isPending={bulkCostTypeMutation.isPending}
          options={costTypeOptions}
          fieldLabel="Cost Type"
          itemNoun="Purchase"
          onConfirm={async (costType) => {
            await bulkCostTypeMutation.mutateAsync({
              ids: bulkCostTypeItems.map((p) => p.id),
              costType: costType as CostType,
            });
          }}
        />
      )}
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
