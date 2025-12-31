import { createColumnHelper } from "@tanstack/react-table";
import { LayoutGrid, List } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { flattenLocations } from "~/lib/location-utils";
import type {
  InfLocation,
  LocationOutWithParentChildren,
  LocationType,
} from "~/schemas/location";
import { useTRPC } from "~/trpc/react";
import {
  createCreatedAtColumn,
  createEntityPillColumn,
  createFilterableSelectColumn,
  createImageColumn,
  createInventoryEntriesColumn,
  createNameColumn,
  createSingleEntityPillColumn,
  createTimestampColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import { LocationTypeBadge } from "../_components/locations/LocationTypeBadge";
import { LocationCardGrid } from "../_components/locations/location-card-grid";
import { locationTypeOptionsWithTheme } from "../_components/locations/location-icons";

export function LocationList() {
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const api = useTRPC();
  const columnHelper = createColumnHelper<LocationOutWithParentChildren>();
  const { onRowClick, PreviewSheet } = useEntityPreview("location");

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
      createEntityPillColumn(columnHelper, "children", "location"),
      createSingleEntityPillColumn(columnHelper, "parent", "location"),
      createFilterableSelectColumn(columnHelper, "type", {
        placeholder: "Filter by type...",
        selectOptions: locationTypeOptionsWithTheme,
        renderCell: (type) => <LocationTypeBadge type={type} />,
      }),
      columnHelper.display({
        id: "inventory_value",
        header: "Valuation",
        cell: (info) => (
          <InventoryValuationSummary
            locationId={info.row.original.id}
            variant="compact"
          />
        ),
        meta: { className: "w-[180px]" },
      }),
      createCreatedAtColumn(columnHelper),
      createTimestampColumn(columnHelper, "lastBulkInventory", {
        header: "Last Bulk Inventory",
        fallback: "Never",
      }),
      createInventoryEntriesColumn(
        columnHelper,
        "inventoryEntries",
        "product",
        (e) => e.product,
        { layout: "inline" },
      ),
    ],
    filters: [
      { id: "name", placeholder: "Filter by location name..." },
      {
        id: "type",
        placeholder: "Filter by type...",
        filterType: "select",
        options: locationTypeOptionsWithTheme,
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
          entity="location"
          onRowClick={onRowClick}
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
      <PreviewSheet />
    </div>
  );
}
