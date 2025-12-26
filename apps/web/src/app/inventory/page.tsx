import { InventoryItemList } from "./inventoryitemlist";
import type { Metadata } from "next";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { InventoryActions } from "./inventory-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Inventory Items",
};

export default function Page() {
  return (
    <EntityLayout title="Inventory Items" actions={<InventoryActions />}>
      <InventoryItemList />
    </EntityLayout>
  );
}
