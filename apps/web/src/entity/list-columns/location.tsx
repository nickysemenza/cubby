import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import {
  type LocationListItemOut,
  locationType,
} from "@cubby/schemas/location";
import { getLocationTypeColor } from "@cubby/shared";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { VerbMenuItem } from "~/entity/actions/action-verb-ui";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { entityListHiddenColumns } from "~/entity/entity-display";
import { relationshipFieldProvenance } from "~/entity/field-provenance";
import type { EntityListParamsByEntity } from "~/entity/generated/entity-lists.gen";
import {
  createEntityInlineLinkColumn,
  createSingleEntityInlineLinkColumn,
} from "~/ui/data-table/columnHelpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";
import type { GroupConfig } from "~/ui/data-table/useGroupedList";
import { useDeferredFilterOptions } from "~/ui/hooks/useDeferredFilterOptions";
import { useFilterOptions } from "~/ui/hooks/useFilterOptions";
import { useUpdateMutation } from "~/ui/hooks/useUpdateMutation";

import { createInventoryEntriesColumn } from "./inventory";
import { defineListOverride } from "./types";

type LocationFilters = EntityListParamsByEntity["location"]["filters"];

const columnHelper = createCubbyColumnHelper<LocationListItemOut>();

// `children`/`inventoryEntries` are relation/computed columns outside the
// field model.
// A function for the same import-cycle reason as product.
const locationInitialColumnVisibility = () => ({
  children: false,
  inventoryEntries: false,
  ...entityListHiddenColumns("location"),
});

const locationGrouping = generatedEntitySort.location.grouping;
if (!locationGrouping)
  throw new Error("location entity declares no list-grouping contract.");

// UI-only: each location type's color swatch has no server-side meaning.
export const LOCATION_GROUP_CONFIG: GroupConfig<LocationListItemOut> = {
  field: locationGrouping.field,
  keyFn: (item) => item.type,
  // Already the raw value the server grouped on — no separate label field.
  rawKeyFn: (item) => item.type,
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
        initialColumnVisibility: locationInitialColumnVisibility(),
        groupConfig: LOCATION_GROUP_CONFIG,
      }),
      [filterOptions],
    );
    return { compose, list };
  },
});
