import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { InventoryActions } from "~/app/inventory/inventory-actions";
import { InventoryItemList } from "~/app/inventory/inventoryitemlist";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields, listHead } from "~/entities/filter-manifest";

const searchSchema = z.object({
  ...tableSearchFields,
  ...entityFilterSearchFields("inventory"),
});
const searchDefaults = {} as const;

export const Route = createFileRoute("/_authenticated/inventory/")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: InventoryPage,
  head: listHead("Inventory", "inventory"),
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
