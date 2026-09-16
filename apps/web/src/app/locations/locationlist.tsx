import {
  type LocationListItemOut,
  locationType,
} from "@cubby/schemas/location";
import { getLocationTypeColor } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import {
  createEntityDisplayColumns,
  entityListHiddenColumns,
} from "~/entities/entity-display";
import { entityListFor } from "~/entities/entity-list.functions";

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
import { EntityListPage } from "../_components/data-table/EntityListPage";
import type { GroupConfig } from "../_components/data-table/useGroupedList";
import { useDeferredFilterOptions } from "../_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "../_components/hooks/useFilterOptions";
import { useLocationParentOptions } from "../_components/hooks/useLocationParentOptions";
import { useUpdateMutation } from "../_components/hooks/useUpdateMutation";
import { InventoryValuationSummary } from "../_components/locations/inventory-valuation-summary";
import { locationTypeOptionsWithTheme } from "../_components/locations/location-icons";
import { LocationTypeLabel } from "../_components/locations/LocationTypeLabel";

/**
 * `aiDescription` is declared `display.listHidden` on `04-location.entity.ts`
 * now; `children`/`inventoryEntries` are relation/computed columns outside
 * the field model, so they stay hand-declared here. Module-level:
 * `initialColumnVisibility` sits in the merged-visibility `useMemo`'s
 * dependency array, so an inline object literal would rebuild it (and the
 * table's column visibility) on every render.
 */
const LOCATION_INITIAL_COLUMN_VISIBILITY = {
  children: false,
  inventoryEntries: false,
  ...entityListHiddenColumns("location"),
};

export function LocationList() {
  const columnHelper = useMemo(
    () => createCubbyColumnHelper<LocationListItemOut>(),
    [],
  );

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
    mutationFn: entityMutationOptionsFactory("location", "update"),
    entity: "location",
  });

  const columns = useMemo(
    () =>
      createCubbyColumnCollection<LocationListItemOut>((add) => {
        const customColumns = createCubbyColumnCollection<LocationListItemOut>(
          (add) => {
            add(createImageColumn(columnHelper, { entity: "location" }));
            add(
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
            );
            add(
              createFilterableSelectColumn(columnHelper, "type", {
                header: "Type",
                className: "w-32",
                placeholder: "Filter by type...",
                selectOptions: locationTypeOptionsWithTheme,
                // A linked location has no type of its own, so this renders empty for
                // one — the adjacent "Is a" column carries its identity instead.
                renderCell: (type) => (
                  <LocationTypeLabel type={type} product={null} />
                ),
                mobile: { slot: "subtitle", priority: 15 },
                editable: {
                  parseValue: (value) => locationType.nullable().parse(value),
                  onSave: async (newType, location) => {
                    await updateLocationMutation.mutateAsync({
                      id: location.id,
                      data: { type: newType },
                    });
                  },
                },
              }),
            );
            add(
              createSingleEntityInlineLinkColumn(
                columnHelper,
                "product",
                "product",
                {
                  header: "Is a",
                  className: "w-56",
                  mobile: { slot: "meta", priority: 40 },
                },
              ),
            );
            add(
              columnHelper.accessor(
                (row) => row.valuation?.directValuation ?? null,
                {
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
                },
              ),
            );
            add(
              createTextColumn(columnHelper, "aiDescription", {
                header: "AI Description",
                className: "min-w-0 w-56 truncate",
                mobile: { slot: "meta", priority: 70 },
              }),
            );
            add(
              createTimestampColumn(columnHelper, "lastBulkInventory", {
                header: "Last Bulk Inventory",
                className: "w-32",
                fallback: "Never",
                mobile: { slot: "meta", priority: 90 },
              }),
            );
          },
        );
        createEntityDisplayColumns(
          "location",
          columnHelper,
          customColumns,
        ).visit(add);
        // These relation/count columns are present only on locationListItemOut;
        // keep them explicit until the entity model declares their ownership.
        add(
          createEntityInlineLinkColumn(columnHelper, "children", "location", {
            header: "Children",
            className: "w-40",
            mobile: { slot: "meta", priority: 55 },
          }),
        );
        add(
          createSingleEntityInlineLinkColumn(
            columnHelper,
            "parent",
            "location",
            {
              header: "Parent",
              className: "w-56",
              mobile: { slot: "subtitle", priority: 20 },
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
            },
          ),
        );
        add(
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
        );
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- updateLocationMutation changes every render but is functionally stable
    [columnHelper],
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
      </>
    ),
    [],
  );

  const groupKeyFn = useCallback((item: LocationListItemOut) => item.type, []);
  const groupColorFn = useCallback((key: string) => {
    const parsedType = locationType.safeParse(key);
    return getLocationTypeColor(parsedType.success ? parsedType.data : null);
  }, []);
  const groupConfig = useMemo(
    (): GroupConfig<LocationListItemOut> => ({
      field: "type",
      keyFn: groupKeyFn,
      colorFn: groupColorFn,
    }),
    [groupKeyFn, groupColorFn],
  );

  return (
    <EntityListPage
      entity="location"
      queryOptions={entityListFor("location").listQueryPlan}
      filterOptions={filterOptions}
      columns={columns}
      extraActions={extraActions}
      initialColumnVisibility={LOCATION_INITIAL_COLUMN_VISIBILITY}
      groupConfig={groupConfig}
      ariaLabel="Locations Table"
    />
  );
}
