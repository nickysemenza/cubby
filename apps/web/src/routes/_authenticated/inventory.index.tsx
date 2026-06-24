import { createFileRoute } from "@tanstack/react-router";
import { InventoryActions } from "~/app/inventory/inventory-actions";
import { InventoryItemList } from "~/app/inventory/inventoryitemlist";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/inventory/")({
  component: InventoryPage,
  head: () => ({ meta: [{ title: "Inventory | cubby" }] }),
});

function InventoryPage() {
  return (
    <Page
      variant="list"
      title="Inventory"
      entity="inventory"
      fullWidth
      actions={
        <div className="flex flex-wrap gap-2">
          <InventoryActions />
        </div>
      }
    >
      <InventoryItemList />
    </Page>
  );
}
