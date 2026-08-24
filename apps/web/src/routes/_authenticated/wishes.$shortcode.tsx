import { createFileRoute } from "@tanstack/react-router";
import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { WishDetail } from "~/app/wishes/wish-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailQueryOptions } from "~/entities/entity-detail";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const WishDetailPage = detailPage({
  query: (shortcode) => entityDetailQueryOptions("wish", shortcode),
  render: (wish, shortcode) => <WishDetail key={shortcode} wish={wish} />,
  title: (wish) => wish.name,
});

const WishNotFound = notFoundPage(
  "wish",
  "Wishlist item not found",
  "It may have been deleted.",
);

export const Route = createFileRoute("/_authenticated/wishes/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailQueryOptions("wish", params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: WishNotFound,
  head: shortcodeHead,
  component: WishDetailPage,
});
