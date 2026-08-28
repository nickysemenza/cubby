import { createFileRoute } from "@tanstack/react-router";

import { InventoryDetail } from "~/app/_components/inventory/inventory-detail";
import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const InventoryDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("inventory").queryOptions(shortcode),
  render: (inventory, shortcode) => (
    <InventoryDetail key={shortcode} inventoryitem={inventory} />
  ),
  title: (inventory) => inventory.product?.name,
});

const InventoryNotFound = notFoundPage(
  "inventory",
  "Inventory item not found",
  "This pantry item is no longer available.",
);

export const Route = createFileRoute("/_authenticated/inventory/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("inventory").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: InventoryNotFound,
  head: shortcodeHead,
  component: InventoryDetailPage,
});
