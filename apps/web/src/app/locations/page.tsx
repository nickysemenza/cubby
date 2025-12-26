import { LocationList } from "./locationlist";
import type { Metadata } from "next";
import LocationTreeGraph from "../_components/inventory/location-tree-graph";
import LocationTreeView from "../_components/inventory/location-tree-view";
import LocationTreemap from "../_components/inventory/location-treemap";
import { LocationGallery } from "../_components/locations/location-gallery";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Suspense } from "react";
import { SimpleLoading } from "~/components/feedback/loading-skeletons";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { LocationActions } from "./location-actions";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Locations",
};

export default function Page() {
  return (
    <EntityLayout title="Locations" actions={<LocationActions />}>
      <Tabs defaultValue="gallery" className="space-y-4">
        <TabsList>
          <TabsTrigger value="gallery">Gallery</TabsTrigger>
          <TabsTrigger value="table">Table</TabsTrigger>
          <TabsTrigger value="visualizations">Visualizations</TabsTrigger>
        </TabsList>

        <TabsContent value="gallery">
          <Suspense fallback={<SimpleLoading text="Loading gallery..." />}>
            <LocationGallery />
          </Suspense>
        </TabsContent>

        <TabsContent value="table">
          <Suspense fallback={<SimpleLoading text="Loading locations..." />}>
            <LocationList />
          </Suspense>
        </TabsContent>

        <TabsContent value="visualizations" className="space-y-6">
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
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
        </TabsContent>
      </Tabs>
    </EntityLayout>
  );
}
