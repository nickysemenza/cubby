import { unsafeProjectId } from "@cubby/schemas/identifiers";
import type {
  CostType,
  PurchaseFilters,
  PurchaseOut,
  Trade,
} from "@cubby/schemas/project";
import { createColumnHelper } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import type { TradeCostCell } from "~/app/projects/charts/trade-cost-matrix";
import type { PivotCostKey } from "~/app/projects/charts/trade-cost-pivot";
import { TradeBadge, tradeOptions } from "~/app/projects/shared";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createCurrencyColumn,
  createFilterableSelectColumn,
  createPlainDateColumn,
  createProjectLinkColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { PurchaseChartStrip } from "./purchase-charts";
import {
  costTypeLabels,
  costTypeOptions,
  futureFilterOptions,
} from "./purchase-options";

/**
 * Column-filter state → tRPC `PurchaseFilters`. Shared by the table query and
 * the chart strip above it so the two can never disagree about what
 * "filtered" means.
 */
function buildPurchaseFilters(
  get: (columnId: string) => string | undefined,
): PurchaseFilters {
  const projectFilter = get("project");
  const futureFilter = get("future");
  return {
    search: get("name"),
    costType: (get("costType") as CostType | undefined) || undefined,
    trade: (get("trade") as Trade | undefined) || undefined,
    projectId: projectFilter ? unsafeProjectId(projectFilter) : undefined,
    future:
      futureFilter === undefined || futureFilter === ""
        ? undefined
        : futureFilter === "true",
  };
}

interface PurchaseListProps {
  /** Actions to display in the table toolbar (e.g., the "New Purchase" button). */
  actions?: ReactNode;
  /**
   * Seed the "name" column filter from the route's `q` search param (e.g. a
   * command-palette deep link). Only used on mount — typing in the search
   * box afterwards behaves normally and does not sync back to the URL.
   */
  initialSearch?: string;
}

export function PurchaseList({ actions, initialSearch }: PurchaseListProps) {
  const api = useTRPC();
  const columnHelper = useMemo(() => createColumnHelper<PurchaseOut>(), []);
  const { options: projectOptions } = useProjectOptions();

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

  const projectFilterOptions = useMemo(
    () => [{ value: "", label: "All projects" }, ...projectOptions],
    [projectOptions],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: updatePurchaseMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createCurrencyColumn(columnHelper, "cost", {
        header: "Cost",
        mobile: { slot: "trailing", priority: 10, interactive: true },
        editable: {
          onSave: async (newCost, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { cost: newCost },
            });
          },
        },
      }),
      createPlainDateColumn(columnHelper, "date", {
        header: "Date",
        className: "w-28",
        mobile: { slot: "subtitle", priority: 15 },
        editable: {
          onSave: async (newDate, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { date: newDate },
            });
          },
        },
      }),
      createFilterableSelectColumn(columnHelper, "costType", {
        header: "Cost Type",
        className: "w-28",
        placeholder: "Filter by cost type...",
        selectOptions: costTypeOptions,
        renderCell: (costType: CostType | null) =>
          costType ? costTypeLabels[costType] : <NoneValue />,
        mobile: { slot: "meta", priority: 20 },
        editable: {
          onSave: async (newCostType, purchase) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!newCostType) return;
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { costType: newCostType },
            });
          },
        },
      }),
      createFilterableSelectColumn(columnHelper, "trade", {
        header: "Trade",
        className: "w-32",
        placeholder: "Filter by trade...",
        selectOptions: tradeOptions,
        renderCell: (trade: Trade | null) =>
          trade ? <TradeBadge trade={trade} /> : <NoneValue />,
        mobile: { slot: "meta", priority: 60 },
        editable: {
          onSave: async (newTrade, purchase) => {
            // Required field — a cleared select is a no-op, not a null write.
            if (!newTrade) return;
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { trade: newTrade },
            });
          },
        },
      }),
      createProjectLinkColumn(columnHelper, {
        className: "w-40",
        mobile: { slot: "meta", priority: 40, interactive: true },
        filterConfig: {
          placeholder: "Filter by project...",
          filterType: "select",
          options: projectFilterOptions,
        },
        editable: {
          onSave: async (newProjectId, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { projectId: newProjectId },
            });
          },
        },
      }),
      columnHelper.accessor((row) => row.future, {
        id: "future",
        header: "Status",
        enableSorting: false,
        meta: {
          className: "w-24",
          mobile: { slot: "meta", priority: 50 },
          filterConfig: {
            placeholder: "Filter by status...",
            filterType: "select",
            options: futureFilterOptions,
          },
        },
        cell: (info) =>
          info.getValue() ? (
            <Badge variant="warning">Planned</Badge>
          ) : (
            <NoneValue />
          ),
      }),
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
              <ExternalLink className="h-3.5 w-3.5" />
              <span className="sr-only">Open link</span>
            </a>
          );
        },
      }),
    ],
    [columnHelper, projectFilterOptions],
  );

  const filters = useMemo(
    () => [
      { id: "name", placeholder: "Search purchases..." },
      {
        id: "costType",
        placeholder: "Filter by cost type...",
        filterType: "select" as const,
        options: costTypeOptions,
      },
      {
        id: "trade",
        placeholder: "Filter by trade...",
        filterType: "select" as const,
        options: tradeOptions,
      },
      {
        id: "future",
        placeholder: "Filter by status...",
        filterType: "select" as const,
        options: futureFilterOptions,
      },
      {
        id: "project",
        placeholder: "Filter by project...",
        filterType: "select" as const,
        options: projectFilterOptions,
      },
    ],
    [projectFilterOptions],
  );

  const tableStateOptions = useSeededFilter("name", initialSearch);
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
  } = useEntityList({
    entity: "purchase",
    queryOptions: api.purchase.list.queryOptions,
    buildFilters: (ts) => buildPurchaseFilters(ts.getColumnFilter),
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    infinite: true,
    tableStateOptions,
  });

  // Mirror the table's active filters for the chart strip. Reading
  // `table.getState()` is reactive — the table re-renders this component on
  // every filter change.
  const columnFilters = table.getState().columnFilters;
  const chartFilters = useMemo(
    () =>
      buildPurchaseFilters(
        (id) =>
          columnFilters.find((f) => f.id === id)?.value as string | undefined,
      ),
    [columnFilters],
  );

  const activeMatrixCell = useMemo<TradeCostCell | null>(() => {
    const trade = chartFilters.trade;
    return trade ? { trade, costType: chartFilters.costType ?? null } : null;
  }, [chartFilters]);

  const handleMatrixCellClick = useCallback(
    (trade: Trade, costType: PivotCostKey | null) => {
      const clear =
        activeMatrixCell?.trade === trade &&
        activeMatrixCell.costType === costType;
      table.getColumn("trade")?.setFilterValue(clear ? undefined : trade);
      table
        .getColumn("costType")
        ?.setFilterValue(clear || costType === null ? undefined : costType);
    },
    [table, activeMatrixCell],
  );

  return (
    <div>
      <PurchaseChartStrip
        filters={chartFilters}
        onMatrixCellClick={handleMatrixCellClick}
        activeMatrixCell={activeMatrixCell}
      />
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Purchases Table"
        timing={timing}
        entity="purchase"
        actions={actions}
        onRowClick={onRowClick}
        onRowHover={onRowHover}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
