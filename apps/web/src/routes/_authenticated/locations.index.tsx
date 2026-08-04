import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Suspense } from "react";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import LocationTreeGraph from "~/app/_components/inventory/location-tree-graph";
import LocationTreeView from "~/app/_components/inventory/location-tree-view";
import LocationTreemap from "~/app/_components/inventory/location-treemap";
import { LocationGallery } from "~/app/_components/locations/location-gallery";
import LocationSunburst from "~/app/_components/visualizations/location-sunburst";
import { LocationActions } from "~/app/locations/location-actions";
import { LocationList } from "~/app/locations/locationlist";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { Grid, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Description } from "~/components/ui/description";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import {
  entityFilterSearchFields,
  getEntityFilters,
  listHead,
} from "~/entities/filter-manifest";

const viewOptions = ["gallery", "table", "visualizations"] as const;
type ViewOption = (typeof viewOptions)[number];

const VIEW_SWITCHER_OPTIONS: ViewSwitcherOption<ViewOption>[] = [
  { value: "gallery", label: "Gallery" },
  { value: "table", label: "Table" },
  { value: "visualizations", label: "Visualizations" },
];

const searchSchema = z.object({
  view: z.enum(viewOptions).optional().catch(undefined),
  ...tableSearchFields,
  ...entityFilterSearchFields("location"),
});

const searchDefaults = { view: undefined } as const;

export const Route = createFileRoute("/_authenticated/locations/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: LocationsPage,
  head: listHead("Locations", "location"),
});

function LocationsPage() {
  const search = Route.useSearch();
  const { view = "gallery" } = search;
  const navigate = useNavigate({ from: Route.fullPath });
  const rawSearch = search as Record<string, unknown>;
  const tableFiltersActive = getEntityFilters("location").some((filter) =>
    Boolean(rawSearch[filter.urlKey ?? filter.columnId]),
  );

  return (
    <Page
      variant="list"
      title="Locations"
      actions={<LocationActions />}
      fullWidth
    >
      <Stack gap="md">
        <ViewSwitcher
          ariaLabel="Locations view"
          options={VIEW_SWITCHER_OPTIONS}
          value={view}
          onValueChange={(v) =>
            navigate({ search: (prev) => ({ ...prev, view: v }) })
          }
        />

        {view !== "table" && tableFiltersActive && (
          <Description>
            Table filters are preserved in the URL but paused in this whole-tree
            renderer. Switch to Table to apply them.
          </Description>
        )}

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
          <Stack gap="md">
            {/* Treemap + sunburst: the two whole-tree distribution views, paired
                so the same hierarchy reads both as area and as rings. */}
            <Grid cols="pair">
              <div>
                <h3 className="mb-2 font-semibold text-lg">
                  Inventory Distribution
                </h3>
                <Description className="mb-4">
                  Size represents total inventory items at each location and its
                  children
                </Description>
                <Suspense
                  fallback={<SimpleLoading text="Loading treemap..." />}
                >
                  <LocationTreemap />
                </Suspense>
              </div>
              <div>
                <h3 className="mb-2 font-semibold text-lg">Sunburst</h3>
                <Description className="mb-4">
                  The same hierarchy as rings — the center is the whole house,
                  each ring a level deeper
                </Description>
                <Suspense
                  fallback={<SimpleLoading text="Loading sunburst..." />}
                >
                  <LocationSunburst />
                </Suspense>
              </div>
            </Grid>

            {/* Tree views side by side */}
            <Grid cols="pair">
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
            </Grid>
          </Stack>
        )}
      </Stack>
    </Page>
  );
}
