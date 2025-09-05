"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/array-helpers";
import RTable from "../_components/data-table/Table";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { UnitMappingGraph } from "../_components/units/UnitMappingGraph";
import { useWasm } from "~/hooks/useWasm";
import { showAmountAndPrice } from "../_components/inventory/format-amount";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import { createCreatedAtColumn } from "../_components/data-table/columnHelpers";
import { ImageThumbnail, TableLink } from "../_components/table";
import Link from "next/link";

import { useQuery } from "@tanstack/react-query";

export function InventoryItemList() {
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Query data with params from table state
  const { data: inventoryitemsResp, isLoading } = useQuery(
    api.inventoryItem.list.queryOptions({
      sort: tableState.getSortParams(),
      pagination: tableState.pagination,
      filters: {
        productNameFilter: tableState.getColumnFilter("product"),
        locationNameFilter: tableState.getColumnFilter("location"),
      },
    }),
  );

  const w = useWasm();
  const data = inventoryitemsResp?.items || [];
  const columnHelper = createColumnHelper<Flatten<typeof data>>();

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
              w,
              info.getValue(),
              info.row.original.product.unitMappings,
            )}
          </Link>
        );
      },
    }),
    columnHelper.accessor("product", {
      enableSorting: false,
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
    totalCount: inventoryitemsResp?.meta?.totalCount || 0,
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
        filterableColumns={filterableColumns}
        isLoading={isLoading}
      />
    </div>
  );
}
