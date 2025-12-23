import { LocationList } from "./locationlist";
import { type Metadata } from "next";
import LocationTreeGraph from "../_components/inventory/location-tree-graph";
import LocationTreeView from "../_components/inventory/location-tree-view";
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

        <TabsContent value="visualizations" className="space-y-4">
          <div className="flex flex-row gap-4">
            <div className="flex-1">
              <h3 className="mb-2 text-lg font-semibold">Tree View</h3>
              <Suspense
                fallback={<SimpleLoading text="Loading tree view..." />}
              >
                <LocationTreeView />
              </Suspense>
            </div>
            <div className="flex-1">
              <h3 className="mb-2 text-lg font-semibold">Tree Graph</h3>
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
