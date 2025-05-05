import { HydrateClient } from "~/trpc/server";
import { LocationList } from "./locationlist";
import { type Metadata } from "next";
import LocationTreeGraph from "../_components/inventory/location-tree-graph";
import LocationTreeView from "../_components/inventory/location-tree-view";
import { WasmContextProvider } from "~/wasmContext";
import Link from "next/link";
import { Button } from "~/components/ui/button";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Locations",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <WasmContextProvider>
          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-2xl font-bold">Locations</h1>
            <Link href="/locations/new">
              <Button>New Location</Button>
            </Link>
          </div>
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
