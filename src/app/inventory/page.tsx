import { HydrateClient } from "~/trpc/server";
import { InventoryItemList } from "./inventoryitemlist";
import { type Metadata } from "next";
import { WasmContextProvider } from "~/wasmContext";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Inventory Items",
};

export default function Page() {
  return (
    <HydrateClient>
      <WasmContextProvider>
        <InventoryItemList />
      </WasmContextProvider>
    </HydrateClient>
  );
}
