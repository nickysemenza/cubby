import { HydrateClient } from "~/trpc/server";
import { InventoryItemList } from "./inventoryitemlist";
import { type Metadata } from "next";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import { WasmContextProvider } from "~/wasmContext";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Inventory Items",
};

export default function Page() {
  return (
    <div className="container mx-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Inventory Items</h1>
        <div className="flex gap-2">
          <Link href="/inventory/bulk-edit">
            <Button variant="outline">Bulk Edit</Button>
          </Link>
          <Link href="/inventory/new">
            <Button>Create New</Button>
          </Link>
        </div>
      </div>
      <HydrateClient>
        <WasmContextProvider>
          <InventoryItemList />
        </WasmContextProvider>
      </HydrateClient>
    </div>
  );
}
