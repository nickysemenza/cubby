"use client";
import { useState } from "react";
import { useTRPC } from "~/trpc/react";
import { createColumnHelper } from "@tanstack/react-table";
import RTable, { FilterableColumn } from "../_components/data-table/Table";
import { useTableConfig } from "../_components/data-table/useTableConfig";
import {
  createCreatedAtColumn,
  createNameColumn,
  createImageColumn,
  createEntityPillColumn,
  createInventoryEntriesColumn,
} from "../_components/data-table/columnHelpers";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { LocationType, locationTypeOptions } from "~/schemas/location";
import { LocationCardGrid } from "../_components/locations/location-card-grid";
import { Button } from "~/components/ui/button";
import { LayoutGrid, List } from "lucide-react";
import {
  type InfLocation,
  type LocationOutWithParentChildren,
} from "~/schemas/location";
import { HoverableTimestamp } from "../_components/HoverableTimestamp";
import { InventoryValueSummary } from "../_components/locations/inventory-value-summary";
import { useTableList } from "../_components/hooks/useTableList";
import { flattenLocations } from "~/lib/location-utils";

export function LocationList() {
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const api = useTRPC();

  const { data, totalCount, isLoading, error, tableState } = useTableList<
    {
      nameFilter: string | undefined;
      itemTypeFilter: LocationType | undefined;
    },
    LocationOutWithParentChildren
  >({
    queryOptions: api.location.list.queryOptions,
    buildFilters: (tableState) => ({
      nameFilter: tableState.getColumnFilter("name"),
      itemTypeFilter: tableState.getColumnFilter("type") as LocationType,
    }),
    tableStateOptions: { initialSort: "createdAt" },
  });

  // Set up columns using helpers
  const columnHelper = createColumnHelper<LocationOutWithParentChildren>();
  const columns = [
    // Image column
    createImageColumn(columnHelper),
    // Name column with link to detail page
    createNameColumn(columnHelper, "location"),
    createEntityPillColumn(
      columnHelper,
      "children",
      LocationPillLink,
      "location",
    ),
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
    columnHelper.display({
      id: "inventory_value",
      header: "Value",
      cell: (info) => (
        <InventoryValueSummary
          locationId={info.row.original.id}
          variant="compact"
        />
      ),
      meta: {
        className: "w-[180px]",
      },
    }),
    createCreatedAtColumn(columnHelper),
    columnHelper.accessor("lastBulkInventory", {
      header: "Last Bulk Inventory",
      cell: (info) => {
        const date = info.getValue();
        return date ? <HoverableTimestamp timestamp={date} /> : "Never";
      },
    }),
    createInventoryEntriesColumn(
      columnHelper,
      "inventoryEntries",
      ProductPillLink,
      "product",
      (e) => e.product,
      { layout: "inline" },
    ),
  ];

  // Configure the table
  const table = useTableConfig({
    data,
    columns,
    tableState,
    totalCount,
  });

  const filterableColumns: FilterableColumn[] = [
    {
      id: "name",
      placeholder: "Filter by location name...",
    },
    {
      id: "type",
      placeholder: "Filter by type...",
      filterType: "select",
      options: locationTypeOptions,
    },
  ];

  return (
    <div className="space-y-4">
      {/* View Toggle */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">All Locations</h2>
        <div className="flex items-center rounded-md border">
          <Button
            variant={viewMode === "table" ? "default" : "ghost"}
            size="sm"
            onClick={() => setViewMode("table")}
          >
            <List className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "cards" ? "default" : "ghost"}
            size="sm"
            onClick={() => setViewMode("cards")}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {viewMode === "table" ? (
        <RTable
          table={table}
          filterableColumns={filterableColumns}
          isLoading={isLoading}
          error={error}
          ariaLabel="Locations Table"
        />
      ) : (
        <div>
          {isLoading ? (
            <div>Loading locations...</div>
          ) : data.length > 0 ? (
            <LocationCardGrid
              locations={flattenLocations(data as InfLocation[])}
              showParentPath={true}
            />
          ) : (
            <div>No locations found.</div>
          )}
        </div>
      )}
    </div>
  );
}
