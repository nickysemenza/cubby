import { nutritionBasis as nutritionBasisSchema } from "@cubby/schemas/nutrition";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";

import { entityDetailFor } from "~/entity/entity-detail";
import { GenericEntityDetail } from "~/entity/entity-detail/generic-entity-detail";
import { recipeDetailClient } from "~/entity/generated/clients/recipe.detail.gen";
import type { EntityDetailByEntity } from "~/entity/generated/entity-details.gen";
import { ensureDetailRecord } from "~/entity/routing/detail-loader";
import { detailPage, notFoundPage } from "~/entity/routing/detail-page";
import EditRecipeForm from "~/features/recipes/edit-recipe";
import { shortcodeHead } from "~/lib/page-title";
import { Page } from "~/ui/page/Page";
import { Button } from "~/ui/primitives/button";
import { RouteErrorComponent } from "~/ui/route-error";
import { DetailPagePending } from "~/ui/route-pending";

/**
 * Hand-written because the workflow slot's state (`view`, `scale`,
 * `nutritionBasis`, `flowLayout`, `costingGap`) and the page-level `edit`
 * mode are URL keys the generic detail route has no search schema for.
 */
const searchSchema = z.object({
  nutritionBasis: nutritionBasisSchema.optional().catch(undefined),
  costingGap: z.boolean().optional().catch(undefined),
  edit: z.boolean().optional().catch(undefined),
  view: z
    .enum(["read", "spec", "data", "prep", "flow"])
    .optional()
    .catch(undefined),
  flowLayout: z
    .enum(["walkthrough", "map", "table"])
    .optional()
    .catch(undefined),
  // Scaling is purely derived/display state, kept in the URL so a scaled view is
  // shareable and printable. `scale` is the resolved factor (absent = 1×).
  scale: z.number().positive().optional().catch(undefined),
});

const searchDefaults = {
  nutritionBasis: undefined,
  costingGap: undefined,
  edit: undefined,
  view: undefined,
  flowLayout: undefined,
  scale: undefined,
} as const;

function RecipeDetailBody({
  recipe,
}: {
  recipe: EntityDetailByEntity["recipe"];
}) {
  const { edit: isEditing } = Route.useSearch();
  const navigate = useNavigate();
  if (!isEditing)
    return <GenericEntityDetail entity="recipe" record={recipe} />;
  const stopEditing = () => {
    void navigate({ to: ".", search: { edit: undefined } });
  };
  return (
    <Page
      variant="detail"
      entity="recipe"
      title={recipe.name}
      rawData={recipe}
      heroNo={recipe.id}
      heroActions={{
        primary: (
          <Button onClick={stopEditing} variant="outline" size="sm">
            <XIcon />
            Cancel
          </Button>
        ),
      }}
    >
      <EditRecipeForm recipe={recipe} onCancel={stopEditing} />
    </Page>
  );
}

const RecipeNotFound = notFoundPage("recipe");

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const RecipeDetailPage = detailPage({
  client: recipeDetailClient,
  query: (shortcode) => entityDetailFor("recipe").queryOptions(shortcode),
  render: (recipe) => <RecipeDetailBody recipe={recipe} />,
  title: (recipe) => recipe.name,
});

export const Route = createFileRoute("/_authenticated/recipes/$shortcode")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  loader: ({ params, context, location }) =>
    ensureDetailRecord(
      context.queryClient,
      entityDetailFor("recipe").queryOptions(params.shortcode),
      { shortcode: params.shortcode, href: location.href },
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: RecipeNotFound,
  head: shortcodeHead,
  component: RecipeDetailPage,
});
