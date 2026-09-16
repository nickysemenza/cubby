import type { ListSlotId } from "@cubby/schemas/entity-manifest";
import { Suspense } from "react";

import type { ListSlotComponent } from "~/app/_components/entity-list/list-slot-types";
import LocationTreeGraph from "~/app/_components/inventory/location-tree-graph";
import LocationTreeView from "~/app/_components/inventory/location-tree-view";
import LocationTreemap from "~/app/_components/inventory/location-treemap";
import { LocationGallery } from "~/app/_components/locations/location-gallery";
import LocationSunburst from "~/app/_components/visualizations/location-sunburst";
import { VisualizationPanel } from "~/app/_components/visualizations/visualization-panel";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Grid, Stack } from "~/components/layout";

const LocationGallerySlot: ListSlotComponent = () => (
  <Suspense fallback={<SimpleLoading text="Loading gallery..." />}>
    <LocationGallery />
  </Suspense>
);

/**
 * Treemap + sunburst (the two whole-tree distribution views, so the same
 * hierarchy reads both as area and as rings), then the tree views side by
 * side.
 */
const LocationVisualizationsSlot: ListSlotComponent = () => (
  <Stack gap="md">
    <Grid cols="pair">
      <VisualizationPanel
        title="Inventory Distribution"
        description="Size represents total inventory items at each location and its children"
        fallback={<SimpleLoading text="Loading treemap..." />}
      >
        <LocationTreemap />
      </VisualizationPanel>
      <VisualizationPanel
        title="Sunburst"
        description="The same hierarchy as rings — the center is the whole house, each ring a level deeper"
        fallback={<SimpleLoading text="Loading sunburst..." />}
      >
        <LocationSunburst />
      </VisualizationPanel>
    </Grid>
    <Grid cols="pair">
      <VisualizationPanel
        title="Tree View"
        fallback={<SimpleLoading text="Loading tree view..." />}
      >
        <LocationTreeView />
      </VisualizationPanel>
      <VisualizationPanel
        title="Tree Graph"
        fallback={<SimpleLoading text="Loading tree graph..." />}
      >
        <LocationTreeGraph />
      </VisualizationPanel>
    </Grid>
  </Stack>
);

export const locationListSlots = {
  gallery: LocationGallerySlot,
  visualizations: LocationVisualizationsSlot,
} satisfies Record<ListSlotId<"location">, ListSlotComponent>;
