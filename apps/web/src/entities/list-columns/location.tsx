import {
  type LocationListItemOut,
  locationType,
} from "@cubby/schemas/location";
import { getLocationTypeColor } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { VerbMenuItem } from "~/app/_components/actions/action-verb-ui";
import {
  createEntityInlineLinkColumn,
  createImageColumn,
  createInventoryEntriesColumn,
  createSingleEntityInlineLinkColumn,
} from "~/app/_components/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/app/_components/data-table/table-features";
import type { GroupConfig } from "~/app/_components/data-table/useGroupedList";
import { useDeferredFilterOptions } from "~/app/_components/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/app/_components/hooks/useFilterOptions";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { InventoryValuationSummary } from "~/app/_components/locations/inventory-valuation-summary";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityListHiddenColumns } from "~/entities/entity-display";
import { relationshipFieldProvenance } from "~/entities/field-provenance";
import type { EntityListParamsByEntity } from "~/entities/generated/entity-lists.gen";

import { defineListOverride } from "./types";

type LocationFilters = EntityListParamsByEntity["location"]["filters"];

const columnHelper = createCubbyColumnHelper<LocationListItemOut>();

// `children`/`inventoryEntries` are relation/computed columns outside the
// field model.
const LOCATION_INITIAL_COLUMN_VISIBILITY = {
  children: false,
  inventoryEntries: false,
  ...entityListHiddenColumns("location"),
};

export const LOCATION_GROUP_CONFIG: GroupConfig<LocationListItemOut> = {
  field: "type",
  keyFn: (item) => item.type,
  colorFn: (key) => {
    const parsedType = locationType.safeParse(key);
    return getLocationTypeColor(parsedType.success ? parsedType.data : null);
  },
};

const extraActions = (row: LocationListItemOut) => (
  <>
    <VerbMenuItem
      verb="recount"
      render={<Link to="/inventory/session" search={{ parent: row.id }} />}
    />
    <VerbMenuItem
      verb="photoPass"
      render={<Link to="/locations/photo-pass" search={{ parent: row.id }} />}
    />
  </>
);

export const locationListOverride = defineListOverride<
  LocationListItemOut,
  LocationFilters
>({
  use() {
    // Runtime picklists for the manifest's `parent` and `product` specs — the
    // latter scoped to products some location IS, not the whole catalog.
    const locationProductOptions = useDeferredFilterOptions(
      "locationIdentityProduct",
    );
    const filterOptions = useFilterOptions({
      locationProducts: locationProductOptions,
    });
    const updateLocationMutation = useUpdateMutation({
      mutationFn: entityMutationOptionsFactory("location", "update"),
      entity: "location",
    });
    const overrides = useMemo(
      () =>
        createCubbyColumnCollection<LocationListItemOut>((add) => {
          add(
            createImageColumn(columnHelper, {
              entity: "location",
              id: "images",
              provenance: relationshipFieldProvenance("location", "images"),
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
        }),
      [],
    );

    const compose = useMemo(
      () => (declared: CubbyColumnCollection<LocationListItemOut>) =>
        createCubbyColumnCollection<LocationListItemOut>((add) => {
          declared.visit(add);
          // Relation/count columns present only on locationListItemOut.
          add(
            createEntityInlineLinkColumn(columnHelper, "children", "location", {
              header: "Children",
              className: "w-40",
              mobile: { slot: "meta", priority: 55 },
              provenance: relationshipFieldProvenance("location", "children"),
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
                provenance: relationshipFieldProvenance(
                  "location",
                  "parent",
                  "reference",
                ),
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
                provenance: relationshipFieldProvenance(
                  "location",
                  "inventory",
                ),
              },
            ),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- updateLocationMutation changes every render but is functionally stable
      [],
    );

    const list = useMemo(
      () => ({
        deletable: true as const,
        filterOptions,
        extraActions,
        initialColumnVisibility: LOCATION_INITIAL_COLUMN_VISIBILITY,
        groupConfig: LOCATION_GROUP_CONFIG,
      }),
      [filterOptions],
    );
    return { overrides, compose, list };
  },
});
