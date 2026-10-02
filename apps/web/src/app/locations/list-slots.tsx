import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { Suspense } from "react";

import type { ListSlotComponent } from "~/entity/entity-list/list-slot-types";
import LocationTreeView from "~/features/inventory/location-tree-view";
import { LocationGallery } from "~/features/locations/location-gallery";
import { SimpleLoading } from "~/ui/feedback/loading-skeletons";
import { Stack } from "~/ui/layout";
import { HierarchyView } from "~/ui/visualizations/hierarchy-view";
import { VisualizationPanel } from "~/ui/visualizations/visualization-panel";

const LocationGallerySlot: ListSlotComponent = () => (
  <Suspense fallback={<SimpleLoading text="Loading gallery..." />}>
    <LocationGallery />
  </Suspense>
);

/** The generic hierarchy (tree + sunburst), then the inventory tree list. */
const LocationVisualizationsSlot: ListSlotComponent = () => (
  <Stack gap="md">
    <HierarchyView entity="location" />
    <VisualizationPanel
      title="Tree View"
      fallback={<SimpleLoading text="Loading tree view..." />}
    >
      <LocationTreeView />
    </VisualizationPanel>
  </Stack>
);

export const locationListSlots = {
  gallery: LocationGallerySlot,
  visualizations: LocationVisualizationsSlot,
} satisfies Record<ListSlotId<"location">, ListSlotComponent>;
