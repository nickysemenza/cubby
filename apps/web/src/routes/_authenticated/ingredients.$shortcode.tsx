import { createFileRoute } from "@tanstack/react-router";
import { IngredientDetail } from "~/app/_components/ingredients/ingredient-detail";
import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { shortcodeHead } from "~/lib/page-title";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const IngredientDetailPage = detailPage({
  query: (api, shortcode) =>
    api.ingredient.getByShortcode.queryOptions({ shortcode }),
  render: (ingredient, shortcode) => (
    <IngredientDetail key={shortcode} ingredient={ingredient} />
  ),
  title: (ingredient) => ingredient.name,
});

const IngredientNotFound = notFoundPage(
  "ingredient",
  "Ingredient not found",
  "This ingredient is no longer available.",
);

export const Route = createFileRoute("/_authenticated/ingredients/$shortcode")({
  loader: ({ params, context }) =>
    ensureDetailRecord(
      context.queryClient,
      context.trpc.ingredient.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: IngredientNotFound,
  head: shortcodeHead,
  component: IngredientDetailPage,
});
