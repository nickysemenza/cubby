import { createFileRoute } from "@tanstack/react-router";

import { LocationDetail } from "~/app/_components/locations/location-detail";
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
const LocationDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("location").queryOptions(shortcode),
  render: (location, shortcode) => (
    <LocationDetail key={shortcode} location={location} />
  ),
  title: (location) => location.name,
});

const LocationNotFound = notFoundPage(
  "location",
  "Location not found",
  "This storage location is no longer available.",
);

export const Route = createFileRoute("/_authenticated/locations/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("location").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: LocationNotFound,
  head: shortcodeHead,
  component: LocationDetailPage,
});
