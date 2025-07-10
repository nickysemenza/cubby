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
import Link from "next/link";
import Image from "next/image";

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
        if (!product.images || product.images.length === 0) {
          return (
            <div className="flex h-12 w-12 items-center justify-center rounded-md border bg-gray-100">
              <span className="text-xs text-gray-500">No image</span>
            </div>
          );
        }

        // Use the first image
        const image = product.images[0];
        return (
          <div className="relative h-12 w-12 overflow-hidden rounded-md border">
            <Image
              src={image.url}
              alt={image.filename || "Product image"}
              fill
              sizes="48px"
              className="object-cover"
            />
            {product.images.length > 1 && (
              <div className="absolute right-0 bottom-0 flex h-5 w-5 items-center justify-center rounded-tl-md bg-black/70 text-xs text-white">
                +{product.images.length - 1}
              </div>
            )}
          </div>
        );
      },
    }),
    columnHelper.accessor("amount", {
      cell: (info) => {
        return (
          <Link
            className="block max-w-64"
            href={`/inventory/${info.row.original.id}`}
          >
            view:{" "}
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
          <div className="space-y-1">
            <ProductPillLink product={product} />
            <div className="mb-2 space-y-1">
              {upc && (
                <div className="text-xs">
                  UPC:{" "}
                  <Link
                    href={`/usda/upc/${upc}`}
                    className="text-blue-600 hover:underline"
                  >
                    {upc}
                  </Link>
                </div>
              )}
              {ndb_number && (
                <div className="text-xs">
                  NDB:{" "}
                  <Link
                    href={`/usda/ndb/${ndb_number}`}
                    className="text-blue-600 hover:underline"
                  >
                    {ndb_number}
                  </Link>
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
