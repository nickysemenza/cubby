import type { LocationListItemOut } from "@cubby/schemas/location";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { entityListHiddenColumns } from "~/entity/display/entity-display";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { relationshipFieldProvenance } from "~/entity/fields/field-provenance";
import type { EntityListParamsByEntity } from "~/entity/generated/entity-lists.gen";
import { useUpdateMutation } from "~/entity/hooks/use-update-mutation";
import { useEntityMetadata } from "~/entity/metadata";
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
const locationInitialColumnVisibility = (queryClient: QueryClient) => ({
  children: false,
  inventoryEntries: false,
  ...entityListHiddenColumns(queryClient, "location"),
});

export const locationListOverride = defineListOverride<
  LocationListItemOut,
  LocationFilters
>({
  use() {
    const queryClient = useQueryClient();
    useEntityMetadata("location");
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
              columnGroup: "Hierarchy",
              className: "w-40",
              mobile: { slot: "meta", priority: 55 },
              provenance: relationshipFieldProvenance(
                queryClient,
                "location",
                "children",
              ),
            }),
          );
          add(
            createSingleEntityInlineLinkColumn(
              queryClient,
              columnHelper,
              "parent",
              "location",
              {
                header: "Parent",
                columnGroup: "Hierarchy",
                className: "w-56",
                mobile: { slot: "subtitle", priority: 20 },
                provenance: relationshipFieldProvenance(
                  queryClient,
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
              (e: LocationListItemOut["inventoryEntries"][number]) => e.product,
              {
                layout: "inline",
                columnGroup: "Stock",
                enableSorting: true,
                mobile: { slot: "meta", priority: 80 },
                provenance: relationshipFieldProvenance(
                  queryClient,
                  "location",
                  "inventory",
                ),
              },
            ),
          );
        }),
      // oxlint-disable-next-line react/exhaustive-deps -- updateLocationMutation changes every render but is functionally stable
      [queryClient],
    );

    const list = useMemo(
      () => ({
        deletable: true as const,
        initialColumnVisibility: locationInitialColumnVisibility(queryClient),
      }),
      [queryClient],
    );
    return { compose, list };
  },
});
