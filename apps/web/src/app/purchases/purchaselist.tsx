import { unsafeProjectId } from "@cubby/schemas/identifiers";
import type {
  PurchaseCategory,
  PurchaseOut,
  Purchaser,
} from "@cubby/schemas/project";
import { createColumnHelper } from "@tanstack/react-table";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Badge } from "~/components/ui/badge";
import { NoneValue } from "~/components/ui/none-value";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createCurrencyColumn,
  createFilterableSelectColumn,
  createPlainDateColumn,
  createProjectLinkColumn,
  createTextColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useNameEditable } from "../_components/hooks/useNameEditable";
import { useProjectOptions } from "../_components/hooks/useProjectOptions";
import { useSeededFilter } from "../_components/hooks/useSeededFilter";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import {
  futureFilterOptions,
  purchaseCategoryLabels,
  purchaseCategoryOptions,
  purchaserLabels,
  purchaserOptions,
} from "./purchase-options";

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
      }),
      createFilterableSelectColumn(columnHelper, "category", {
        header: "Category",
        className: "w-28",
        placeholder: "Filter by category...",
        selectOptions: purchaseCategoryOptions,
        renderCell: (cat: PurchaseCategory | null) =>
          cat ? purchaseCategoryLabels[cat] : <NoneValue />,
        mobile: { slot: "meta", priority: 20 },
        editable: {
          onSave: async (newCategory, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { category: newCategory },
            });
          },
        },
      }),
      createTextColumn(columnHelper, "subcategory", {
        header: "Subcategory",
        className: "min-w-0 w-32 truncate",
        mobile: { slot: "meta", priority: 60 },
        editable: {
          onSave: async (newValue, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { subcategory: newValue },
            });
          },
        },
      }),
      createFilterableSelectColumn(columnHelper, "purchaser", {
        header: "Purchaser",
        className: "w-28",
        placeholder: "Filter by purchaser...",
        selectOptions: purchaserOptions,
        renderCell: (p: Purchaser | null) =>
          p ? purchaserLabels[p] : <NoneValue />,
        mobile: { slot: "meta", priority: 30 },
        editable: {
          onSave: async (newPurchaser, purchase) => {
            await updatePurchaseMutation.mutateAsync({
              id: purchase.id,
              data: { purchaser: newPurchaser },
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
        id: "category",
        placeholder: "Filter by category...",
        filterType: "select" as const,
        options: purchaseCategoryOptions,
      },
      {
        id: "purchaser",
        placeholder: "Filter by purchaser...",
        filterType: "select" as const,
        options: purchaserOptions,
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
    buildFilters: (ts) => {
      const projectFilter = ts.getColumnFilter("project");
      const futureFilter = ts.getColumnFilter("future");
      return {
        search: ts.getColumnFilter("name"),
        category: ts.getColumnFilter("category") as
          | PurchaseCategory
          | undefined,
        purchaser: ts.getColumnFilter("purchaser") as Purchaser | undefined,
        projectId: projectFilter ? unsafeProjectId(projectFilter) : undefined,
        future:
          futureFilter === undefined || futureFilter === ""
            ? undefined
            : futureFilter === "true",
      };
    },
    columns,
    filters,
    deletable: deletableConfig,
    nameEditable,
    infinite: true,
    tableStateOptions,
  });

  return (
    <div>
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
