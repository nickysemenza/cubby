import { createFileRoute } from "@tanstack/react-router";
import { InventoryActions } from "~/app/inventory/inventory-actions";
import { InventoryItemList } from "~/app/inventory/inventoryitemlist";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/inventory/")({
  component: InventoryPage,
  head: () => ({ meta: [{ title: "Inventory | cubby" }] }),
});

function InventoryPage() {
  return (
    <EntityLayout
      title="Inventory"
      fullWidth
      actions={
        <div className="flex flex-wrap gap-2">
          <InventoryActions />
        </div>
      }
    >
      <InventoryItemList />
    </EntityLayout>
  );
}
