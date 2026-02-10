import type {
  LocationOutWithParentChildren,
  LocationType,
} from "@cubby/schemas/location";
import { getLocationTypeColor } from "@cubby/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Printer, ScanBarcode } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import {
  createCreatedAtColumn,
  createEntityPillColumn,
  createFilterableSelectColumn,
  createImageColumn,
  createInventoryEntriesColumn,
  createNameColumn,
  createSingleEntityPillColumn,
  createTextColumn,
  createTimestampColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import type { GroupConfig } from "../_components/data-table/useGroupedList";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import { LocationTypeBadge } from "../_components/locations/LocationTypeBadge";
import { locationTypeOptionsWithTheme } from "../_components/locations/location-icons";
import { typeSupportsQrCode } from "../_components/locations/location-type-theme";

export function LocationList() {
  const api = useTRPC();
  const navigate = useNavigate();
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

  // Memoize columns to prevent recreating on every render
  // Note: updateLocationMutation is NOT in dependencies because useMutation returns a new object every render
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateLocationMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createImageColumn(columnHelper, { entity: "location" }),
      createNameColumn(columnHelper, "location", "name", {
        mobile: { slot: "title", priority: 0 },
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
      createEntityPillColumn(columnHelper, "children", "location", {
        mobile: { slot: "meta", priority: 55 },
      }),
      createSingleEntityPillColumn(columnHelper, "parent", "location", {
        mobile: { slot: "subtitle", priority: 20 },
      }),
      createFilterableSelectColumn(columnHelper, "type", {
        placeholder: "Filter by type...",
        selectOptions: locationTypeOptionsWithTheme,
        renderCell: (type) => <LocationTypeBadge type={type} />,
        mobile: { slot: "subtitle", priority: 15 },
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
        meta: {
          className: "w-[180px]",
          mobile: { slot: "trailing", priority: 10 },
        },
      }),
      createTextColumn(columnHelper, "aiDescription", {
        header: "AI Description",
        className: "max-w-[300px]",
        mobile: { slot: "meta", priority: 70 },
      }),
      createCreatedAtColumn(columnHelper),
      createTimestampColumn(columnHelper, "lastBulkInventory", {
        header: "Last Bulk Inventory",
        fallback: "Never",
        mobile: { slot: "meta", priority: 90 },
      }),
      createInventoryEntriesColumn(
        columnHelper,
        "inventoryEntries",
        "product",
        (e) => e.product,
        {
          layout: "inline",
          mobile: { slot: "meta", priority: 80 },
        },
      ),
    ],
    [columnHelper],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigate is stable
  const bulkActions = useMemo(
    () => ({
      actions: [
        {
          id: "print-labels",
          label: "Print Labels",
          icon: <Printer className="h-4 w-4" />,
          minSelection: 1,
          onExecute: async (
            rows: import("@tanstack/react-table").Row<LocationOutWithParentChildren>[],
          ) => {
            const eligible = rows.filter((r) =>
              typeSupportsQrCode(r.original.type),
            );
            const skipped = rows.length - eligible.length;

            if (eligible.length === 0) {
              toast.error(
                "None of the selected locations support QR code labels (rooms and areas are excluded)",
              );
              return { success: false };
            }

            if (skipped > 0) {
              toast.info(
                `Skipped ${skipped} location${skipped === 1 ? "" : "s"} without QR support (rooms/areas)`,
              );
            }

            const codes = eligible.map((r) => r.original.shortcode).join(",");
            navigate({ to: "/labels", search: { codes } });
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  const extraActions = useCallback(
    (row: LocationOutWithParentChildren) => (
      <>
        <DropdownMenuItem
          render={
            <Link
              to="/inventory/quick-capture"
              search={{ locationId: row.id }}
            />
          }
        >
          <ScanBarcode className="mr-2 h-4 w-4" />
          Quick Capture Here
        </DropdownMenuItem>
        {row.shortcode && typeSupportsQrCode(row.type) && (
          <DropdownMenuItem
            render={<Link to="/labels" search={{ codes: row.shortcode }} />}
          >
            <Printer className="mr-2 h-4 w-4" />
            Print Label
          </DropdownMenuItem>
        )}
      </>
    ),
    [],
  );

  // Group by location type for mobile section headers
  const groupKeyFn = useCallback(
    (item: LocationOutWithParentChildren) => item.type,
    [],
  );
  const groupColorFn = useCallback(
    (key: string) => getLocationTypeColor(key as LocationType),
    [],
  );
  const groupConfig = useMemo(
    (): GroupConfig<LocationOutWithParentChildren> => ({
      field: "type",
      keyFn: groupKeyFn,
      colorFn: groupColorFn,
    }),
    [groupKeyFn, groupColorFn],
  );

  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
    grouped,
    onGroupedChange,
  } = useEntityList({
    entity: "location",
    queryOptions: api.location.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
      itemTypeFilter: ts.getColumnFilter("type") as LocationType,
    }),
    columns,
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
    bulkActions,
    extraActions,
    infinite: true,
    groupConfig,
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
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
        groupConfig={groupConfig}
        grouped={grouped}
        onGroupedChange={onGroupedChange}
      />
      <PreviewSheet />
      {deleteDialog}
    </>
  );
}
