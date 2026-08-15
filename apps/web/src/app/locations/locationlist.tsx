import type {
  LocationListItemOut,
  LocationType,
} from "@cubby/schemas/location";
import { getLocationTypeColor } from "@cubby/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { Camera, FolderInput, Printer, ScanBarcode } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePageCount } from "~/components/page/Page";
import { DropdownMenuItem } from "~/components/ui/dropdown-menu";
import { useTRPC } from "~/integrations/trpc/react";
import { locationMutationInvalidateKeys } from "~/lib/query-keys";
import {
  createEntityInlineLinkColumn,
  createFilterableSelectColumn,
  createImageColumn,
  createInventoryEntriesColumn,
  createNameColumn,
  createSingleEntityInlineLinkColumn,
  createTextColumn,
  createTimestampColumn,
} from "../_components/data-table/columnHelpers";
import RTable from "../_components/data-table/Table";
import type { GroupConfig } from "../_components/data-table/useGroupedList";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useLocationParentOptions } from "../_components/hooks/useLocationParentOptions";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { BulkReparentLocationsDialog } from "../_components/locations/bulk-reparent-locations-dialog";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import { LocationTypeLabel } from "../_components/locations/LocationTypeLabel";
import { locationTypeOptionsWithTheme } from "../_components/locations/location-icons";
import { typeSupportsQrCode } from "../_components/locations/location-type-theme";

export function LocationList() {
  const api = useTRPC();
  const navigate = useNavigate();
  const columnHelper = useMemo(
    () => createColumnHelper<LocationListItemOut>(),
    [],
  );
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("location");
  const [reparentLocations, setReparentLocations] = useState<
    LocationListItemOut[]
  >([]);

  // Runtime picklist for the manifest's `parent` spec (optionsKey: "parentLocation").
  const { options: parentLocationOptions } = useLocationParentOptions();
  const filterOptions = useFilterOptions({
    parentLocation: parentLocationOptions,
  });

  const updateLocationMutation = useUpdateMutation({
    mutationFn: api.location.update.mutationOptions,
    entity: "location",
    invalidateKeys: locationMutationInvalidateKeys,
  });

  const deletableConfig = useDeletableConfig({
    mutationFn: api.location.delete.mutationOptions,
    entityLabel: "Location",
    invalidateKeys: locationMutationInvalidateKeys,
    entity: "location",
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: updateLocationMutation changes every render but is functionally stable
  const columns = useMemo(
    () => [
      createImageColumn(columnHelper, { entity: "location" }),
      createNameColumn(columnHelper, "location", "name", {
        // Keeps the default w-64. This used to be a bare `min-w-0` so the
        // auto-width name would split the leftover with the slack spacer —
        // but an auto column under table-fixed absorbs the squeeze in the
        // other direction too, collapsing toward 0 on a narrow window. The
        // zero-width trailing gutter gets the same no-dead-space result safely.
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
      createEntityInlineLinkColumn(columnHelper, "children", "location", {
        header: "Children",
        className: "w-40",
        mobile: { slot: "meta", priority: 55 },
      }),
      createSingleEntityInlineLinkColumn(columnHelper, "parent", "location", {
        header: "Parent",
        className: "w-56",
        mobile: { slot: "subtitle", priority: 20 },
        // No `filterConfig` here — the manifest's `location.parent` spec
        // (idMulti + nullable) now always overlays this column via
        // `useStandardColumns`, so a hand-coded fallback would be dead code.
        editable: {
          onSave: async (newParentId, location) => {
            await updateLocationMutation.mutateAsync({
              id: location.id,
              data: { parentId: newParentId },
            });
          },
          clearable: true,
          filterItems: (item, row) => item.id !== row.id,
        },
      }),
      createFilterableSelectColumn(columnHelper, "type", {
        header: "Type",
        className: "w-32",
        placeholder: "Filter by type...",
        selectOptions: locationTypeOptionsWithTheme,
        renderCell: (type) => <LocationTypeLabel type={type} />,
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
      columnHelper.accessor((row) => row.valuation?.directValuation ?? null, {
        id: "valuation",
        header: "Valuation",
        cell: (info) => (
          <InventoryValuationSummary
            valuation={info.row.original.valuation}
            variant="compact"
          />
        ),
        meta: {
          className: "w-[180px]",
          numeric: true,
          mobile: { slot: "trailing", priority: 10 },
        },
      }),
      createTextColumn(columnHelper, "aiDescription", {
        header: "AI Description",
        className: "min-w-0 w-56 truncate",
        mobile: { slot: "meta", priority: 70 },
      }),
      createTimestampColumn(columnHelper, "lastBulkInventory", {
        header: "Last Bulk Inventory",
        className: "w-32",
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
          enableSorting: true,
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
          icon: <Printer className="size-4" />,
          minSelection: 1,
          onExecute: async (
            rows: import("@tanstack/react-table").Row<LocationListItemOut>[],
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

            const codes = eligible.map((r) => r.original.id).join(",");
            navigate({ to: "/labels", search: { codes } });
            return { success: true };
          },
        },
        {
          id: "move-parent",
          label: "Move under...",
          icon: <FolderInput className="size-4" />,
          minSelection: 1,
          onExecute: async (
            rows: import("@tanstack/react-table").Row<LocationListItemOut>[],
          ) => {
            setReparentLocations(rows.map((r) => r.original));
            return { success: true };
          },
        },
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  const extraActions = useCallback(
    (row: LocationListItemOut) => (
      <>
        <DropdownMenuItem
          render={<Link to="/inventory/session" search={{ parent: row.id }} />}
        >
          <ScanBarcode className="mr-2 size-4" />
          Recount
        </DropdownMenuItem>
        <DropdownMenuItem
          render={
            <Link to="/locations/photo-pass" search={{ parent: row.id }} />
          }
        >
          <Camera className="mr-2 size-4" />
          Photo pass
        </DropdownMenuItem>
        {row.id && typeSupportsQrCode(row.type) && (
          <DropdownMenuItem
            render={<Link to="/labels" search={{ codes: row.id }} />}
          >
            <Printer className="mr-2 size-4" />
            Print Label
          </DropdownMenuItem>
        )}
      </>
    ),
    [],
  );

  const groupKeyFn = useCallback((item: LocationListItemOut) => item.type, []);
  const groupColorFn = useCallback(
    (key: string) => getLocationTypeColor(key as LocationType),
    [],
  );
  const groupConfig = useMemo(
    (): GroupConfig<LocationListItemOut> => ({
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
    totalCount,
  } = useEntityList({
    entity: "location",
    queryOptions: api.location.list.queryOptions,
    filterOptions,
    columns,
    deletable: deletableConfig,
    bulkActions,
    extraActions,
    initialColumnVisibility: {
      children: false,
      aiDescription: false,
      createdAt: false,
      inventoryEntries: false,
    },
    groupConfig,
  });
  usePageCount(totalCount);

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
        onRowHover={onRowHover}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
        groupConfig={groupConfig}
        grouped={grouped}
        onGroupedChange={onGroupedChange}
      />
      <PreviewSheet />
      {deleteDialog}
      <BulkReparentLocationsDialog
        open={reparentLocations.length > 0}
        onOpenChange={(open) => {
          if (!open) setReparentLocations([]);
        }}
        locations={reparentLocations}
        onSuccess={() => {
          setReparentLocations([]);
          table.resetRowSelection();
        }}
      />
    </>
  );
}
