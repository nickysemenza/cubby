"use client";
import { useState } from "react";
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
import { LocationCardGrid } from "../_components/locations/location-card-grid";
import { Button } from "~/components/ui/button";
import { LayoutGrid, List } from "lucide-react";
import { type InfLocation } from "~/schemas/location";

import { useQuery } from "@tanstack/react-query";
import { HoverableTimestamp } from "../_components/HoverableTimestamp";
import { NoneState } from "../_components/NoneState";
import { InventoryValueSummary } from "../_components/locations/inventory-value-summary";

export function LocationList() {
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const api = useTRPC();
  // Set up table state
  const tableState = useTableState({ initialSort: "createdAt" });

  // Query data with params from table state
  const {
    data: itemsResp,
    isLoading,
    error,
  } = useQuery(
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
    createNameColumn(columnHelper, "location"),
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

  // Get flat list of all locations for card view
  const flattenLocations = (locations: InfLocation[]): InfLocation[] => {
    const result: InfLocation[] = [];
    for (const loc of locations) {
      result.push(loc);
      if (loc.children) {
        result.push(...flattenLocations(loc.children));
      }
    }
    return result;
  };

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
