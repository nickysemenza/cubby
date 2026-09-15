import { createFileRoute } from "@tanstack/react-router";

import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { MealDetailPage } from "~/app/meals/meal-detail-page";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const MealDetailRoute = detailPage({
  query: (shortcode) => entityDetailFor("meal").queryOptions(shortcode),
  render: (meal) => <MealDetailPage mealId={meal.id} />,
  title: (meal) => meal.displayName,
});

const MealNotFound = notFoundPage(
  "meal",
  "Meal not found",
  "This meal is no longer available.",
);

export const Route = createFileRoute("/_authenticated/meals/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("meal").queryOptions(params.shortcode),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: MealNotFound,
  head: shortcodeHead,
  component: MealDetailRoute,
});
