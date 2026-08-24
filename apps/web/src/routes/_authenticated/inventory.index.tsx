import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { listPage } from "~/app/_components/routing/entity-routes";
import { InventoryActions } from "~/app/inventory/inventory-actions";
import { InventoryItemList } from "~/app/inventory/inventoryitemlist";
import { inventorySearchSchema } from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const InventoryPage = listPage({
  title: "Inventory",
  list: InventoryItemList,
  actions: () => (
    <div className="flex flex-wrap gap-2">
      <InventoryActions />
    </div>
  ),
});

export const Route = createFileRoute("/_authenticated/inventory/")({
  validateSearch: inventorySearchSchema,
  search: { middlewares: [stripSearchParams({})] },
  head: () => ({ meta: [{ title: pageTitle("Inventory") }] }),
  component: InventoryPage,
});
