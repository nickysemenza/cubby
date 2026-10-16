import type { LocationListItemOut } from "@cubby/schemas/location";
import { useMemo } from "react";

import { entityListHiddenColumns } from "~/entity/display/entity-display";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { relationshipFieldProvenance } from "~/entity/fields/field-provenance";
import type { EntityListParamsByEntity } from "~/entity/generated/entity-lists.gen";
import { useDeferredFilterOptions } from "~/entity/hooks/use-deferred-filter-options";
import { useFilterOptions } from "~/entity/hooks/use-filter-options";
import { useUpdateMutation } from "~/entity/hooks/use-update-mutation";
import {
  createEntityInlineLinkColumn,
  createSingleEntityInlineLinkColumn,
} from "~/entity/table/column-helpers";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  type CubbyColumnCollection,
} from "~/ui/data-table/table-features";

import { defineListOverride } from "../../entity/list-columns/types";
import { createInventoryEntriesColumn } from "../inventory/list-columns";

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
        initialColumnVisibility: locationInitialColumnVisibility(),
      }),
      [filterOptions],
    );
    return { compose, list };
  },
});
