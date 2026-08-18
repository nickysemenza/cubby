import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import { tableSearchFields } from "~/app/_components/data-table/table-search";
import { InventoryActions } from "~/app/inventory/inventory-actions";
import { InventoryItemList } from "~/app/inventory/inventoryitemlist";
import { Page } from "~/components/page/Page";
import { entityFilterSearchFields } from "~/entities/filter-search-fields";
import { pageTitle } from "~/lib/page-title";
import { urlShortcodeParam } from "~/lib/search-params";

export const inventorySearchSchema = z.object({
  ...tableSearchFields,
  ...entityFilterSearchFields("inventory"),
  productId: urlShortcodeParam("product"),
  locationId: urlShortcodeParam("location"),
});
const searchDefaults = {} as const;

export const Route = createFileRoute("/_authenticated/inventory/")({
  validateSearch: inventorySearchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  component: InventoryPage,
  head: () => ({ meta: [{ title: pageTitle("Inventory") }] }),
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
