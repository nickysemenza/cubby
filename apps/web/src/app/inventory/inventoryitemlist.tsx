"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import RTable from "../_components/data-table/Table";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { UnitMappingGraph } from "../_components/units/UnitMappingGraph";
import { showAmountAndPrice } from "../_components/inventory/format-amount";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import { createCreatedAtColumn } from "../_components/data-table/columnHelpers";
import { ImageThumbnail, TableLink } from "../_components/table";
import Link from "next/link";
import { useTableList } from "../_components/hooks/useTableList";
import { InventoryValueSummary } from "../_components/locations/inventory-value-summary";
import { type InventoryItem } from "../_components/locations/calculate-inventory-value";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { type z } from "zod";

type InventoryListItem = z.infer<typeof inventoryWithLocationAndProductOut>;

export function InventoryItemList() {
  const api = useTRPC();

  const { data, totalCount, isLoading, error, tableState } = useTableList<
    {
      productNameFilter: string | undefined;
      locationNameFilter: string | undefined;
    },
    InventoryListItem
  >({
    queryOptions: api.inventoryItem.list.queryOptions,
    buildFilters: (tableState) => ({
      productNameFilter: tableState.getColumnFilter("product"),
      locationNameFilter: tableState.getColumnFilter("location"),
    }),
    tableStateOptions: { initialSort: "createdAt" },
  });

  const columnHelper = createColumnHelper<InventoryListItem>();

  // Set up columns using helpers where possible
  const columns = [
    // Create a custom image column that uses product images
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
      meta: {
        mobileCategory: "wide",
      },
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
      meta: {
        mobileCategory: "wide",
      },
      enableSorting: false,
      cell: (info) => {
        const item = info.getValue();
        return (
          <>
            <LocationPillLink location={item} />
          </>
        );
      },
    }),

    createCreatedAtColumn(columnHelper),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount,
  });

  const filterableColumns = [
    {
      id: "product",
      placeholder: "Filter by product...",
    },
    {
      id: "location",
      placeholder: "Filter by location...",
    },
  ];

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
