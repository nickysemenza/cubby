import { HydrateClient } from "~/trpc/server";
import { LocationList } from "./locationlist";
import { type Metadata } from "next";
import LocationTreeGraph from "../_components/inventory/location-tree-graph";
import LocationTreeView from "../_components/inventory/location-tree-view";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { entities } from "~/entities/entities";
import { PageWrapper } from "~/components/ui/page-wrapper";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Locations",
};

export default function Page() {
  return (
    <HydrateClient>
      <PageWrapper>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Locations</h1>
          <Link href={`/${entities.location.basePath}/new`}>
            <Button>New Location</Button>
          </Link>
        </div>
        <div className="flex flex-row">
          <LocationTreeView />
          <LocationTreeGraph />
        </div>
        <LocationList />
      </PageWrapper>
    </HydrateClient>
  );
}
