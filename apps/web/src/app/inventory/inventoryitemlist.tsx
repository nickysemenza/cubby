import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import type { z } from "zod";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { useTRPC } from "~/trpc/react";
import { createCreatedAtColumn } from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { EntityPillLink } from "../_components/EntityPill";
import { useEntityList } from "../_components/hooks/useEntityList";
import { tryFormatAmount } from "../_components/inventory/format-amount";
import type { InventoryItem } from "../_components/locations/calculate-inventory-valuation";
import { InventoryValueSummary } from "../_components/locations/inventory-value-summary";
import { NoneState } from "../_components/NoneState";
import { ImageThumbnail } from "../_components/table/ImageThumbnail";
import { TableLink } from "../_components/table/TableLink";
import { UnitMappingGraph } from "../_components/units/UnitMappingGraph";

type InventoryListItem = z.infer<typeof inventoryWithLocationAndProductOut>;

export function InventoryItemList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<InventoryListItem>();

  const { table, data, isLoading, error, timing } = useEntityList({
    entity: "inventory-item",
    queryOptions: api.inventoryItem.list.queryOptions,
    buildFilters: (ts) => ({
      productNameFilter: ts.getColumnFilter("product"),
      locationNameFilter: ts.getColumnFilter("location"),
    }),
    // Inventory has custom columns (product image, amount instead of name)
    columns: [
      // Image from product
      columnHelper.accessor("product", {
        id: "product_image",
        header: "Image",
        enableSorting: false,
        cell: (info) => {
          const product = info.getValue();
          return <ImageThumbnail images={product.images} alt="Product image" />;
        },
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
      columnHelper.accessor("valuation", {
        header: "Valuation",
        cell: (info) => {
          const val = info.getValue();
          if (val === null || val === undefined) return <NoneState />;
          return `$${val.toFixed(2)}`;
        },
      }),
      columnHelper.accessor("product", {
        enableSorting: false,
        meta: {
          mobileCategory: "wide",
          filterConfig: { placeholder: "Filter product..." },
        },
        cell: (info) => {
          const product = info.getValue();
          const { upc, unitMappings } = product;
          return (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 space-y-0.5">
                <EntityPillLink entity="product" data={product} />
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
      columnHelper.accessor("location", {
        enableSorting: false,
        meta: {
          mobileCategory: "wide",
          filterConfig: { placeholder: "Filter location..." },
        },
        cell: (info) => {
          const item = info.getValue();
          return <EntityPillLink entity="location" data={item} />;
        },
      }),
      createCreatedAtColumn(columnHelper),
    ],
    filters: ["product", "location"],
  });

  return (
    <div>
      <RTable
        table={table}
        additionalToolbarContent={
          <InventoryValueSummary
            items={data as InventoryItem[]}
            variant="compact"
          />
        }
        isLoading={isLoading}
        error={error}
        ariaLabel="Inventory Items Table"
        timing={timing}
        entityType="inventory"
      />
    </div>
  );
}
