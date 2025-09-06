"use client";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import { type Flatten } from "~/misc/array-helpers";
import RTable, { FilterableColumn } from "../_components/data-table/Table";
import { useTableState } from "../_components/data-table/useTableState";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createNameColumn,
  createImageColumn,
} from "../_components/data-table/columnHelpers";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { LocationType, locationType } from "~/schemas/location";
import { tryFormatMeasure } from "../_components/inventory/format-amount";
import { useWasm } from "~/hooks/useWasm";
import { EntityPillLinkList } from "../_components/EntityPillLinkList";

import { useQuery } from "@tanstack/react-query";
import { HoverableTimestamp } from "../_components/HoverableTimestamp";
import { NoneState } from "../_components/NoneState";

export function LocationList() {
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Query data with params from table state
  const { data: itemsResp, isLoading } = useQuery(
    api.location.list.queryOptions({
      sort: tableState.getSortParams(),
      pagination: tableState.pagination,
      filters: {
        nameFilter: tableState.getColumnFilter("name"),
        itemTypeFilter: tableState.getColumnFilter("type") as LocationType,
      },
    }),
  );
  const w = useWasm();

  // Set up columns using helpers
  const data = itemsResp?.items || [];
  const columnHelper = createColumnHelper<Flatten<typeof data>>();
  const columns = [
    // Image column
    createImageColumn(columnHelper),
    // Name column with link to detail page
    createNameColumn(columnHelper, "locations"),
    columnHelper.accessor("children", {
      enableSorting: false,
      cell: (info) => (
        <EntityPillLinkList
          items={info.getValue()}
          Pill={LocationPillLink}
          pillPropName="location"
        />
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
        return date ? <HoverableTimestamp timestamp={date} /> : "Never";
      },
    }),
    columnHelper.accessor("inventoryEntries", {
      enableSorting: false,
      cell: (info) => {
        const entries = info.getValue();
        if (!entries || entries.length === 0) {
          return <NoneState />;
        }
        return (
          <div className="space-y-0.5 text-xs">
            {entries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-1">
                <span className="text-muted-foreground">
                  {tryFormatMeasure(w, entry.amount)}
                </span>
                <ProductPillLink product={entry.product} />
              </div>
            ))}
          </div>
        );
      },
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
