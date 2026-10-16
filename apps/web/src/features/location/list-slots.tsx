import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { Suspense } from "react";

import type { ListSlotComponent } from "~/entity/entity-list/list-slot-types";
import LocationTreeView from "~/features/inventory/location-tree-view";
import { LocationGallery } from "~/features/location/location-gallery";
import { HierarchyView } from "~/features/product-category/hierarchy-view";
import { Stack } from "~/ui/layout";

const LocationGallerySlot: ListSlotComponent = () => (
  <Suspense>
    <LocationGallery />
  </Suspense>
);

/** The generic hierarchy (tree + sunburst), then the inventory tree list. */
const LocationVisualizationsSlot: ListSlotComponent = () => (
  <Stack gap="md">
    <HierarchyView entity="location" />
    <LocationTreeView />
  </Stack>
);

export const locationListSlots = {
  gallery: LocationGallerySlot,
  visualizations: LocationVisualizationsSlot,
} satisfies Record<ListSlotId<"location">, ListSlotComponent>;
