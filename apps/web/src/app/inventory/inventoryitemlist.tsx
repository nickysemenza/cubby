"use client";

import { createColumnHelper } from "@tanstack/react-table";
import Link from "next/link";
import type { z } from "zod";
import type { inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { useTRPC } from "~/trpc/react";
import { createCreatedAtColumn } from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { useEntityList } from "../_components/hooks/useEntityList";
import { showAmountAndPrice } from "../_components/inventory/format-amount";
import type { InventoryItem } from "../_components/locations/calculate-inventory-value";
import { InventoryValueSummary } from "../_components/locations/inventory-value-summary";
import { ImageThumbnail, TableLink } from "../_components/table";
import { UnitMappingGraph } from "../_components/units/UnitMappingGraph";

type InventoryListItem = z.infer<typeof inventoryWithLocationAndProductOut>;

export function InventoryItemList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<InventoryListItem>();

  const { table, filterableColumns, data, isLoading, error } = useEntityList({
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
        cell: (info) => {
          return (
            <Link
              className="block max-w-64"
              href={`/inventory/${info.row.original.id}`}
            >
              {showAmountAndPrice(
                info.getValue(),
                info.row.original.product.unitMappings,
              )}
            </Link>
          );
        },
      }),
      columnHelper.accessor("product", {
        enableSorting: false,
        meta: { mobileCategory: "wide" },
        cell: (info) => {
          const product = info.getValue();
          const { upc, ndb_number, unitMappings } = product;
          return (
            <div className="space-y-0.5">
              <ProductPillLink product={product} />
              <div className="space-y-0.5 text-xs">
                {upc && (
                  <div>
                    UPC:{" "}
                    <TableLink href={`/usda/upc/${upc}`} variant="mono">
                      {upc}
                    </TableLink>
                  </div>
                )}
                {ndb_number && (
                  <div>
                    NDB:{" "}
                    <TableLink href={`/usda/ndb/${ndb_number}`} variant="mono">
                      {ndb_number}
                    </TableLink>
                  </div>
                )}
              </div>
              <UnitMappingGraph unitMapping={unitMappings} />
            </div>
          );
        },
      }),
      columnHelper.accessor("location", {
        meta: { mobileCategory: "wide" },
        enableSorting: false,
        cell: (info) => {
          const item = info.getValue();
          return <LocationPillLink location={item} />;
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
        additionalFilters={
          <InventoryValueSummary
            items={data as InventoryItem[]}
            variant="compact"
          />
        }
        filterableColumns={filterableColumns}
        isLoading={isLoading}
        error={error}
        ariaLabel="Inventory Items Table"
      />
    </div>
  );
}
