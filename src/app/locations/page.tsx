import { HydrateClient } from "~/trpc/server";
import { LocationList } from "./locationlist";
import { type Metadata } from "next";
import LocationTreeGraph from "../_components/inventory/location-tree-graph";
import LocationTreeView from "../_components/inventory/location-tree-view";
import { WasmContextProvider } from "~/wasmContext";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Recipes",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <WasmContextProvider>
          <div className="flex flex-row">
            <LocationTreeView />
            <LocationTreeGraph />
          </div>
          <LocationList />
        </WasmContextProvider>
      </div>
    </HydrateClient>
  );
}
