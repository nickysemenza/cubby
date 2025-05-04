"use client";

import { api } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/util";
import RTable from "../_components/data-table/Table";
import JsonRenderer from "../_components/json-renderer";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { buildunitMappingsGraph } from "../_components/units/UnitMappingGraph";
import { useWasm } from "~/wasmContext";
import { showAmountAndPrice } from "../_components/inventory/format-amount";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createIdColumn,
} from "../_components/data-table/columnHelpers";

export function InventoryItemList() {
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Query data with params from table state
  const [inventoryitemsResp] = api.inventoryItem.list.useSuspenseQuery({
    sort: tableState.getSortParams(),
    pagination: tableState.pagination,
    productNameFilter: tableState.getColumnFilter("product"),
    locationNameFilter: tableState.getColumnFilter("location"),
  });

  const { w } = useWasm();
  const data = inventoryitemsResp.items;
  const columnHelper = createColumnHelper<Flatten<typeof data>>();

  // Set up columns using helpers where possible
  const columns = [
    columnHelper.accessor("product", {
      enableSorting: false,
      cell: (info) => {
        const product = info.getValue();
        const { upc, ndb_number, unitMappings } = product;
        return (
          <>
            <JsonRenderer input={{ upc, ndb_number }} />
            <div>{w && buildunitMappingsGraph(w, unitMappings)}</div>
            <ProductPillLink product={product} />
          </>
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
    columnHelper.accessor("amount", {
      cell: (info) => {
        return (
          w &&
          showAmountAndPrice(
            w,
            info.getValue(),
            info.row.original.product.unitMappings,
          )
        );
      },
    }),
    createCreatedAtColumn(columnHelper),
    createIdColumn(columnHelper, "inventory"),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: inventoryitemsResp.meta.totalCount,
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
      <RTable table={table} filterableColumns={filterableColumns} />
    </div>
  );
}
