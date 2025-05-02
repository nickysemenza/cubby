import { HydrateClient } from "~/trpc/server";
import { LocationList } from "./locationlist";
import { type Metadata } from "next";
import LocationTreeGraph from "../_components/inventory/location-tree-graph";
import LocationTreeView from "../_components/inventory/location-tree-view";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <LocationTreeGraph />
        <LocationTreeView />
        <LocationList />
      </div>
    </HydrateClient>
  );
}
