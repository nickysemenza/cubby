import { createFileRoute, Link } from "@tanstack/react-router";
import { InventoryActions } from "~/app/inventory/inventory-actions";
import { InventoryItemList } from "~/app/inventory/inventoryitemlist";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/inventory/")({
  component: InventoryPage,
  head: () => ({ meta: [{ title: "Inventory | cubby" }] }),
});

function InventoryPage() {
  return (
    <EntityLayout
      title="Inventory"
      actions={
        <div className="flex gap-2">
          <InventoryActions />
          <Link to="/inventory/new">
            <Button>Add Inventory</Button>
          </Link>
        </div>
      }
    >
      <InventoryItemList />
    </EntityLayout>
  );
}
