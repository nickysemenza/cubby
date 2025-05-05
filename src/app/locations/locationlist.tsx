"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/util";
import RTable, { FilterableColumn } from "../_components/data-table/Table";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createIdColumn,
} from "../_components/data-table/columnHelpers";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { LocationType, locationType } from "~/schemas/location";
import { tryFormatMeasure } from "../_components/inventory/format-amount";
import { useWasm } from "~/wasmContext";

import { useQuery } from "@tanstack/react-query";

export function LocationList() {
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Query data with params from table state
  const { data: itemsResp, isLoading } = useQuery(
    api.location.list.queryOptions({
      sort: tableState.getSortParams(),
      pagination: tableState.pagination,
      nameFilter: tableState.getColumnFilter("name"),
      itemTypeFilter: tableState.getColumnFilter("type") as LocationType,
    }),
  );
  const { w } = useWasm();

  // Set up columns using helpers
  const data = itemsResp?.items || [];
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    // Custom name column
    columnHelper.accessor("name", {
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor("children", {
      enableSorting: false,
      cell: (info) => (
        <div>
          {info.getValue().map((child) => (
            <div key={child.id}>
              <LocationPillLink location={child} />
            </div>
          ))}
        </div>
      ),
    }),
    columnHelper.accessor("parent", {
      enableSorting: false,
      cell: (info) => {
        const item = info.getValue();
        return <div>{item && <LocationPillLink location={item} />}</div>;
      },
    }),
    columnHelper.accessor("type", {
      cell: (info) => info.getValue(),
    }),
    createCreatedAtColumn(columnHelper),
    columnHelper.accessor("lastBulkInventory", {
      header: "Last Bulk Inventory",
      cell: (info) => {
        const date = info.getValue();
        return date ? new Date(date).toLocaleString() : "Never";
      },
    }),
    createIdColumn(columnHelper, "locations"),
    columnHelper.accessor("inventoryEntries", {
      enableSorting: false,
      cell: (info) =>
        info.getValue().map((e) => (
          <div key={e.id}>
            {w && tryFormatMeasure(w, e.amount)}
            <ProductPillLink product={e.product} />
          </div>
        )),
    }),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: itemsResp?.meta?.totalCount || 0,
  });

  // Get the location types from zod schema

  const filterableColumns: FilterableColumn[] = [
    {
      id: "name",
      placeholder: "Filter by location name...",
    },
    {
      id: "type",
      placeholder: "Filter by type...",
      filterType: "select",
      options: Object.values(locationType.enum).map((type) => ({
        value: type,
        label: type,
      })),
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
