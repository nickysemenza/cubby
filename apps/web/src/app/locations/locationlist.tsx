import {
  type LocationListItemOut,
  type LocationType,
  locationCoverImage,
} from "@cubby/schemas/location";
import { getLocationTypeColor } from "@cubby/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  VerbMenuItem,
  verbBulkAction,
} from "~/app/_components/actions/action-verb-ui";
import { createCubbyColumnHelper } from "~/app/_components/data-table/table-features";
import { usePageCount } from "~/components/page/Page";
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
import { ListWorkbench } from "../_components/data-table/ListWorkbench";
import type { GroupConfig } from "../_components/data-table/useGroupedList";
import { useDeferredFilterOptions } from "../_components/hooks/useDeferredFilterOptions";
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
    () => createCubbyColumnHelper<LocationListItemOut>(),
    [],
  );
  const { onRowClick, onRowHover, PreviewSheet } = useEntityPreview("location");
  const [reparentLocations, setReparentLocations] = useState<
    LocationListItemOut[]
  >([]);

  // Runtime picklist for the manifest's `parent` spec (optionsKey: "parentLocation").
  const { options: parentLocationOptions } = useLocationParentOptions();
  // Runtime picklist for the `product` spec (optionsKey: "locationProducts") —
  // scoped to products some location IS, not the whole catalog, so the
  // dropdown lists the dozen vessel SKUs rather than thousands of groceries.
  const locationProductOptions = useDeferredFilterOptions(
    "locationIdentityProduct",
  );
  const filterOptions = useFilterOptions({
    parentLocation: parentLocationOptions,
    locationProducts: locationProductOptions,
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
      createImageColumn(columnHelper, {
        entity: "location",
        // A bin that IS a photographed tote should show the tote. The default
        // accessor only reads `row.images`, so those rendered the placeholder.
        getImages: (location) => {
          const cover = locationCoverImage(location);
          return cover ? [cover] : [];
        },
      }),
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
        // A linked location has no type of its own, so this renders empty for
        // one — the adjacent "Is a" column carries its identity instead.
        renderCell: (type) => <LocationTypeLabel type={type} product={null} />,
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
      createSingleEntityInlineLinkColumn(columnHelper, "product", "product", {
        header: "Is a",
        className: "w-56",
        mobile: { slot: "meta", priority: 40 },
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
        verbBulkAction<LocationListItemOut>("printLabels", {
          id: "print-labels",
          minSelection: 1,
          onExecute: async (rows) => {
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
        }),
        verbBulkAction<LocationListItemOut>("moveUnder", {
          id: "move-parent",
          minSelection: 1,
          onExecute: async (rows) => {
            setReparentLocations(rows.map((r) => r.original));
            return { success: true };
          },
        }),
      ],
      clearSelectionOnComplete: false,
    }),
    [],
  );

  const extraActions = useCallback(
    (row: LocationListItemOut) => (
      <>
        <VerbMenuItem
          verb="recount"
          render={<Link to="/inventory/session" search={{ parent: row.id }} />}
        />
        <VerbMenuItem
          verb="photoPass"
          render={
            <Link to="/locations/photo-pass" search={{ parent: row.id }} />
          }
        />
        {row.id && typeSupportsQrCode(row.type) && (
          <VerbMenuItem
            verb="printLabel"
            render={<Link to="/labels" search={{ codes: row.id }} />}
          />
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

  const { workbench, totalCount } = useEntityList({
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
      <ListWorkbench
        model={workbench}
        ariaLabel="Locations Table"
        onRowClick={onRowClick}
        onRowHover={onRowHover}
      />
      <PreviewSheet />
      <BulkReparentLocationsDialog
        open={reparentLocations.length > 0}
        onOpenChange={(open) => {
          if (!open) setReparentLocations([]);
        }}
        locations={reparentLocations}
        onSuccess={() => {
          setReparentLocations([]);
          workbench.table.resetRowSelection();
        }}
      />
    </>
  );
}
