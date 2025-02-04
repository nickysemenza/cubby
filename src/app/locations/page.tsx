import { HydrateClient } from "~/trpc/server";
import { LocationList } from "../_components/locationlist";
import { type Metadata } from "next";
import LocationTree from "../_components/recipe/locationtree";

export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <LocationTree />
        <LocationList />
      </div>
    </HydrateClient>
  );
}
