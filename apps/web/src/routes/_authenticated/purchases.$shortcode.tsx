import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { PurchaseDetail } from "~/app/purchases/purchase-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const PurchaseDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("purchase").queryOptions(shortcode),
  render: (purchase, shortcode) => (
    <PurchaseDetail key={shortcode} purchase={purchase} />
  ),
  title: (purchase) => purchase.displayName,
});

const PurchaseNotFound = notFoundPage(
  "purchase",
  "Purchase not found",
  "This purchase is no longer available.",
);

export const Route = createFileRoute("/_authenticated/purchases/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("purchase").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: PurchaseNotFound,
  head: shortcodeHead,
  component: PurchaseDetailPage,
});
