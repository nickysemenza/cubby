import { createColumnHelper } from "@tanstack/react-table";
import type {
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
import { locationTypeOptionsWithTheme } from "../_components/locations/location-icons";

export function LocationList() {
  const api = useTRPC();
  const columnHelper = createColumnHelper<LocationOutWithParentChildren>();
  const { onRowClick, PreviewSheet } = useEntityPreview("location");

  const { table, isLoading, error, timing } = useEntityList({
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
    <>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Locations Table"
        timing={timing}
        entity="location"
        onRowClick={onRowClick}
      />
      <PreviewSheet />
    </>
  );
}
