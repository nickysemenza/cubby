import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { VendorDetail } from "~/app/vendors/vendor-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const VendorDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("vendor").queryOptions(shortcode),
  render: (vendor, shortcode) => (
    <VendorDetail key={shortcode} vendor={vendor} />
  ),
  title: (vendor) => vendor.name,
});

const VendorNotFound = notFoundPage(
  "vendor",
  "Vendor not found",
  "This vendor is no longer available.",
);

export const Route = createFileRoute("/_authenticated/vendors/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("vendor").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: VendorNotFound,
  head: shortcodeHead,
  component: VendorDetailPage,
});
