import type { inventoryWithLocationAndProductOut } from "@cubby/schemas/combo";
import { Link, useNavigate } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowRightLeft } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import {
  createCreatedAtColumn,
  createCurrencyColumn,
  createImageColumn,
  createSingleEntityPillColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { EntityPillLink } from "../_components/EntityPill";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { AiSearchBar } from "../_components/inventory/ai-search-bar";
import { tryFormatAmount } from "../_components/inventory/format-amount";
import { MoveInventoryDialog } from "../_components/inventory/move-inventory-dialog";
import type { InventoryItem } from "../_components/locations/calculate-inventory-valuation";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import { TableLink } from "../_components/table/TableLink";

type InventoryListItem = z.infer<typeof inventoryWithLocationAndProductOut>;

export function InventoryItemList() {
  const api = useTRPC();
  const navigate = useNavigate();
  const columnHelper = createColumnHelper<InventoryListItem>();
  const { onRowClick, PreviewSheet } = useEntityPreview("inventory");
  const [moveTarget, setMoveTarget] = useState<InventoryListItem | null>(null);
  const [bulkMoveItems, setBulkMoveItems] = useState<InventoryListItem[]>([]);

  const extraActions = useCallback(
    (row: InventoryListItem) => (
      <DropdownMenuItem
        onClick={(e) => {
          e.stopPropagation();
          setMoveTarget(row);
        }}
      >
        <ArrowRightLeft className="mr-2 h-4 w-4" />
        Move to...
      </DropdownMenuItem>
    ),
    [],
  );

  // Memoize deletable config to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.inventory.delete.mutationOptions,
    entityLabel: "Inventory Entry",
    invalidateKeys: [[queryKeys.inventory.list]],
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigate is stable
  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "move",
          label: "Move",
          icon: <ArrowRightLeft className="h-4 w-4" />,
          minSelection: 1,
          onExecute: async (
            rows: import("@tanstack/react-table").Row<InventoryListItem>[],
          ) => {
            const items = rows.map((r) => r.original);
            const locationIds = new Set(items.map((i) => i.location.id));

            if (locationIds.size === 1) {
              // All from same location — use dialog
              setBulkMoveItems(items);
            } else {
              // Multiple source locations — redirect to bulk move page
              toast.info(
                "Items from multiple locations selected — opening bulk move page",
              );
              navigate({ to: "/inventory/bulk-move" });
            }

            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  const {
    table,
    data,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
  } = useEntityList({
    entity: "inventory",
    queryOptions: api.inventory.list.queryOptions,
    buildFilters: (ts) => ({
      productNameFilter: ts.getColumnFilter("product"),
      locationNameFilter: ts.getColumnFilter("location"),
    }),
    // Inventory has custom columns (product image, amount instead of name)
    columns: [
      createImageColumn(columnHelper, {
        getImages: (row) => row.product.images,
        entity: "inventory",
      }),
      columnHelper.accessor("amount", {
        header: "Qty",
        meta: {
          mobile: { slot: "trailing", priority: 10 },
        },
        cell: (info) => {
          return (
            <Link
              className="block max-w-64"
              to="/inventory/$id"
              params={{ id: info.row.original.id }}
            >
              {tryFormatAmount(info.getValue())}
            </Link>
          );
        },
      }),
      createCurrencyColumn(columnHelper, "valuation", {
        header: "Valuation",
        mobile: { slot: "trailing", priority: 30 },
      }),
      columnHelper.accessor("product", {
        enableSorting: false,
        meta: {
          className: "min-w-0 w-56 max-w-72",
          mobile: { slot: "meta", priority: 50 },
          filterConfig: { placeholder: "Filter product..." },
        },
        cell: (info) => {
          const product = info.getValue();
          const { upc } = product;
          return (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <EntityPillLink entity="product" data={product} compact />
                {upc && (
                  <div className="text-muted-foreground text-xs">
                    <TableLink
                      to="/usda/upc/$code"
                      params={{ code: upc }}
                      variant="mono"
                    >
                      {upc}
                    </TableLink>
                  </div>
                )}
              </div>
            </div>
          );
        },
      }),
      createSingleEntityPillColumn(columnHelper, "location", "location", {
        className: "min-w-0 w-40 max-w-56",
        mobile: { slot: "subtitle", priority: 20 },
        filterConfig: { placeholder: "Filter location..." },
      }),
      createCreatedAtColumn(columnHelper),
    ],
    filters: ["product", "location"],
    deletable: deletableConfig,
    extraActions,
    bulkActions,
    infinite: true,
  });

  return (
    <div>
      <AiSearchBar table={table} />
      <RTable
        table={table}
        additionalToolbarContent={
          <InventoryValuationSummary
            items={data as InventoryItem[]}
            variant="compact"
          />
        }
        isLoading={isLoading}
        error={error}
        ariaLabel="Inventory Items Table"
        timing={timing}
        entity="inventory"
        onRowClick={onRowClick}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
      {deleteDialog}
      {moveTarget && (
        <MoveInventoryDialog
          open={!!moveTarget}
          onOpenChange={(open) => {
            if (!open) setMoveTarget(null);
          }}
          items={[moveTarget]}
          onSuccess={() => setMoveTarget(null)}
        />
      )}
      {bulkMoveItems.length > 0 && (
        <MoveInventoryDialog
          open={bulkMoveItems.length > 0}
          onOpenChange={(open) => {
            if (!open) setBulkMoveItems([]);
          }}
          items={bulkMoveItems}
          onSuccess={() => setBulkMoveItems([])}
        />
      )}
    </div>
  );
}
