import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { Suspense } from "react";

import type { ListSlotComponent } from "~/app/_components/entity-list/list-slot-types";
import LocationTreeView from "~/app/_components/inventory/location-tree-view";
import { LocationGallery } from "~/app/_components/locations/location-gallery";
import { HierarchyView } from "~/app/_components/visualizations/hierarchy-view";
import { VisualizationPanel } from "~/app/_components/visualizations/visualization-panel";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Stack } from "~/components/layout";

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
