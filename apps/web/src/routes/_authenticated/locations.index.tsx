import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Suspense } from "react";
import { z } from "zod";
import LocationTreeGraph from "~/app/_components/inventory/location-tree-graph";
import LocationTreeView from "~/app/_components/inventory/location-tree-view";
import LocationTreemap from "~/app/_components/inventory/location-treemap";
import { LocationGallery } from "~/app/_components/locations/location-gallery";
import { LocationActions } from "~/app/locations/location-actions";
import { LocationList } from "~/app/locations/locationlist";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { EntityLayout } from "~/components/layouts/entity-layout";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";

const viewOptions = ["gallery", "table", "visualizations"] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "gallery", label: "Gallery" },
  { value: "table", label: "Table" },
  { value: "visualizations", label: "Visualizations" },
];

const searchSchema = z.object({
  view: z.enum(viewOptions).optional().catch(undefined),
});

const searchDefaults = { view: undefined } as const;

export const Route = createFileRoute("/_authenticated/locations/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: LocationsPage,
  head: () => ({ meta: [{ title: "Locations | cubby" }] }),
});

function LocationsPage() {
  const { view = "gallery" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <EntityLayout title="Locations" actions={<LocationActions />} fullWidth>
      <div className="space-y-4">
        <ViewSwitcher
          ariaLabel="Locations view"
          options={VIEW_SWITCHER_OPTIONS}
          value={view}
          onValueChange={(v) => navigate({ search: { view: v } })}
        />

        {view === "gallery" && (
          <Suspense fallback={<SimpleLoading text="Loading gallery..." />}>
            <LocationGallery />
          </Suspense>
        )}

        {view === "table" && (
          <Suspense fallback={<SimpleLoading text="Loading locations..." />}>
            <LocationList />
          </Suspense>
        )}

        {view === "visualizations" && (
          <div className="space-y-4">
            {/* Treemap - full width */}
            <div>
              <h3 className="mb-2 font-semibold text-lg">
                Inventory Distribution
              </h3>
              <p className="mb-3 text-muted-foreground text-sm">
                Size represents total inventory items at each location and its
                children
              </p>
              <Suspense fallback={<SimpleLoading text="Loading treemap..." />}>
                <LocationTreemap />
              </Suspense>
            </div>

            {/* Tree views side by side */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 font-semibold text-lg">Tree View</h3>
                <Suspense
                  fallback={<SimpleLoading text="Loading tree view..." />}
                >
                  <LocationTreeView />
                </Suspense>
              </div>
              <div>
                <h3 className="mb-2 font-semibold text-lg">Tree Graph</h3>
                <Suspense
                  fallback={<SimpleLoading text="Loading tree graph..." />}
                >
                  <LocationTreeGraph />
                </Suspense>
              </div>
            </div>
          </div>
        )}
      </div>
    </EntityLayout>
  );
}
