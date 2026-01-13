import { createColumnHelper } from "@tanstack/react-table";
import { useMemo } from "react";
import { queryKeys } from "~/lib/query-keys";
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
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import { LocationTypeBadge } from "../_components/locations/LocationTypeBadge";
import { locationTypeOptionsWithTheme } from "../_components/locations/location-icons";

export function LocationList() {
  const api = useTRPC();
  const columnHelper = useMemo(
    () => createColumnHelper<LocationOutWithParentChildren>(),
    [],
  );
  const { onRowClick, PreviewSheet } = useEntityPreview("location");

  // Memoize invalidate keys to prevent recreating on every render
  const invalidateKeys = useMemo(() => [queryKeys.location.list] as const, []);

  // Memoize mutation function to prevent recreating on every render
  const mutationFn = useMemo(() => api.location.update.mutationOptions, [api]);

  // Mutation for inline editing (name, type)
  const updateLocationMutation = useUpdateMutation({
    mutationFn,
    entity: "location",
    invalidateKeys,
  });

  // Memoize deletable config to prevent infinite render loop
  const deletableConfig = useDeletableConfig({
    mutationFn: api.location.delete.mutationOptions,
    entityLabel: "Location",
    invalidateKeys: [[queryKeys.location.list]],
  });

  const { table, isLoading, error, timing, bulkActionBar, deleteDialog } =
    useEntityList({
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
          editable: {
            onSave: async (newName, location) => {
              await updateLocationMutation.mutateAsync({
                id: location.id,
                data: { name: newName },
              });
            },
          },
        }),
        createEntityPillColumn(columnHelper, "children", "location"),
        createSingleEntityPillColumn(columnHelper, "parent", "location"),
        createFilterableSelectColumn(columnHelper, "type", {
          placeholder: "Filter by type...",
          selectOptions: locationTypeOptionsWithTheme,
          renderCell: (type) => <LocationTypeBadge type={type} />,
          editable: {
            onSave: async (newType, location) => {
              await updateLocationMutation.mutateAsync({
                id: location.id,
                data: { type: newType },
              });
            },
          },
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
      deletable: deletableConfig,
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
        bulkActionBar={bulkActionBar}
      />
      <PreviewSheet />
      {deleteDialog}
    </>
  );
}
