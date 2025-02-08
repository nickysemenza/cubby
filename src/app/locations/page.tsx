import { HydrateClient } from "~/trpc/server";
import { LocationList } from "./locationlist";
import { type Metadata } from "next";
import LocationTree from "../_components/recipe/locationtree";
import LocationTreeView from "../_components/recipe/locationtreeview";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <LocationTree />
        <LocationTreeView />
        <LocationList />
      </div>
    </HydrateClient>
  );
}
