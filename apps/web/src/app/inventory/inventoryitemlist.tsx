import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import type { z } from "zod";
import { queryKeys } from "~/lib/query-keys";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { useTRPC } from "~/trpc/react";
import {
  createCreatedAtColumn,
  createCurrencyColumn,
  createImageColumn,
  createSingleEntityPillColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { EntityPillLink } from "../_components/EntityPill";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { tryFormatAmount } from "../_components/inventory/format-amount";
import type { InventoryItem } from "../_components/locations/calculate-inventory-valuation";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import { TableLink } from "../_components/table/TableLink";
import { UnitMappingGraph } from "../_components/units/UnitMappingGraph";

type InventoryListItem = z.infer<typeof inventoryWithLocationAndProductOut>;

export function InventoryItemList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<InventoryListItem>();
  const { onRowClick, PreviewSheet } = useEntityPreview("inventory");

  const { table, data, isLoading, error, timing, bulkActionBar, deleteDialog } =
    useEntityList({
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
        }),
        columnHelper.accessor("amount", {
          header: "Qty",
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
        }),
        columnHelper.accessor("product", {
          enableSorting: false,
          meta: {
            className: "min-w-0 w-56 max-w-72",
            mobileCategory: "wide",
            filterConfig: { placeholder: "Filter product..." },
          },
          cell: (info) => {
            const product = info.getValue();
            const { upc, unitMappings } = product;
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
                <UnitMappingGraph unitMapping={unitMappings} compact />
              </div>
            );
          },
        }),
        createSingleEntityPillColumn(columnHelper, "location", "location", {
          className: "min-w-0 w-40 max-w-56",
          mobileCategory: "wide",
          filterConfig: { placeholder: "Filter location..." },
        }),
        createCreatedAtColumn(columnHelper),
      ],
      filters: ["product", "location"],
      deletable: {
        mutationOptions: (callbacks) =>
          api.inventory.delete.mutationOptions(callbacks),
        entityLabel: "Inventory Entry",
        invalidateKeys: [queryKeys.inventoryItem.list],
      },
    });

  return (
    <div>
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
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
