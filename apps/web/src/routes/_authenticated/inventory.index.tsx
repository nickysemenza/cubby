import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { InventoryActions } from "~/app/inventory/inventory-actions";
import { InventoryItemList } from "~/app/inventory/inventoryitemlist";
import { Page } from "~/components/page/Page";

const searchSchema = z.object(tableSearchFields);
const searchDefaults = {} as const;

export const Route = createFileRoute("/_authenticated/inventory/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: InventoryPage,
  head: () => ({ meta: [{ title: "Inventory | cubby" }] }),
});

function InventoryPage() {
  return (
    <Page
      variant="list"
      title="Inventory"
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
