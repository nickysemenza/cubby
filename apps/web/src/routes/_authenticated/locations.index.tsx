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
import { VisualizationPanel } from "~/app/_components/visualizations/visualization-panel";
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
import { getEntityFilters } from "~/entities/filter-manifest";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";

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
  head: () => ({ meta: [{ title: pageTitle("Locations") }] }),
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

            {/* Tree views side by side */}
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
        )}
      </Stack>
    </Page>
  );
}
