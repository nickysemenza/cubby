import { HydrateClient } from "~/trpc/server";
import { LocationList } from "./locationlist";
import { type Metadata } from "next";
import LocationTreeGraph from "../_components/inventory/location-tree-graph";
import LocationTreeView from "../_components/inventory/location-tree-view";
import { LocationsOverview } from "../_components/locations/locations-overview";
import { PageWrapper } from "~/components/ui/page-wrapper";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Locations",
};

export default function Page() {
  return (
    <HydrateClient>
      <PageWrapper>
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
            <TabsTrigger value="legacy">Legacy Views</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <LocationsOverview />
          </TabsContent>

          <TabsContent value="table">
            <LocationList />
          </TabsContent>

          <TabsContent value="legacy" className="space-y-4">
            <div className="flex flex-row gap-4">
              <div className="flex-1">
                <h3 className="mb-2 text-lg font-semibold">Tree View</h3>
                <LocationTreeView />
              </div>
              <div className="flex-1">
                <h3 className="mb-2 text-lg font-semibold">Tree Graph</h3>
                <LocationTreeGraph />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </PageWrapper>
    </HydrateClient>
  );
}
