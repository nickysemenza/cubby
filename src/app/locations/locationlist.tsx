"use client";

import { api } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/util";
import RTable from "../_components/data-table/Table";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import { createCreatedAtColumn, createIdColumn } from "../_components/data-table/columnHelpers";
import { LocationPillLink } from "../_components/EntityPill";
import JsonRenderer from "../_components/json-renderer";

export function LocationList() {
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });
  
  // Query data with params from table state
  const [itemsResp] = api.location.list.useSuspenseQuery({
    sort: tableState.getSortParams(),
    pagination: tableState.pagination,
    nameFilter: tableState.getColumnFilter("name"),
    itemTypeFilter: tableState.getColumnFilter("type"),
  });

  // Set up columns using helpers
  const data = itemsResp.items;
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
    createIdColumn(columnHelper, "locations"),
    columnHelper.accessor("inventoryEntries", {
      enableSorting: false,
      cell: (info) => {
        return <JsonRenderer input={info.getValue()} />;
      },
    }),
  ];
  
  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount: itemsResp.meta.totalCount,
  });

  const filterableColumns = [
    {
      id: "name",
      placeholder: "Filter by location name...",
    },
    {
      id: "type",
      placeholder: "Filter by type...",
    },
  ];

  return (
    <div>
      <RTable table={table} filterableColumns={filterableColumns} />
    </div>
  );
}
