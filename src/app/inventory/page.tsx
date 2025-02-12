import { HydrateClient } from "~/trpc/server";
import { InventoryItemList } from "./inventoryitemlist";
import { type Metadata } from "next";

export const metadata: Metadata = {
  title: "Inventory Items",
};

export default function Page() {
  return (
    <HydrateClient>
      <div>
        <InventoryItemList />
      </div>
    </HydrateClient>
  );
}
