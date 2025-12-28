import { createColumnHelper } from "@tanstack/react-table";
import { LayoutGrid, List } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { flattenLocations } from "~/lib/location-utils";
import type {
  InfLocation,
  LocationOutWithParentChildren,
} from "~/schemas/location";
import { type LocationType, locationTypeOptions } from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import {
  createCreatedAtColumn,
  createEntityPillColumn,
  createImageColumn,
  createInventoryEntriesColumn,
  createNameColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { LocationPillLink, ProductPillLink } from "../_components/EntityPill";
import { HoverableTimestamp } from "../_components/HoverableTimestamp";
import { useEntityList } from "../_components/hooks/useEntityList";
import { InventoryValueSummary } from "../_components/locations/inventory-value-summary";
import { LocationCardGrid } from "../_components/locations/location-card-grid";

export function LocationList() {
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const api = useTRPC();
  const columnHelper = createColumnHelper<LocationOutWithParentChildren>();

  const { table, data, isLoading, error, timing } = useEntityList({
    entity: "location",
    queryOptions: api.location.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
      itemTypeFilter: ts.getColumnFilter("type") as LocationType,
    }),
    // Location has custom column order (createdAt in middle), so we define all columns
    columns: [
      createImageColumn(columnHelper),
      createNameColumn(columnHelper, "location", "name", {
        filterConfig: { placeholder: "Filter by location name..." },
      }),
      createEntityPillColumn(
        columnHelper,
        "children",
        LocationPillLink,
        "location",
        { minimal: true },
      ),
      columnHelper.accessor("parent", {
        enableSorting: false,
        cell: (info) => {
          const item = info.getValue();
          return (
            <div>{item && <LocationPillLink location={item} minimal />}</div>
          );
        },
      }),
      columnHelper.accessor("type", {
        meta: {
          filterConfig: {
            placeholder: "Filter by type...",
            filterType: "select",
            options: locationTypeOptions,
          },
        },
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
        meta: { className: "w-[180px]" },
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
        { layout: "inline", minimal: true },
      ),
    ],
    filters: [
      { id: "name", placeholder: "Filter by location name..." },
      {
        id: "type",
        placeholder: "Filter by type...",
        filterType: "select",
        options: locationTypeOptions,
      },
    ],
  });

  return (
    <div className="space-y-4">
      {/* View Toggle */}
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-lg">All Locations</h2>
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
          isLoading={isLoading}
          error={error}
          ariaLabel="Locations Table"
          timing={timing}
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
