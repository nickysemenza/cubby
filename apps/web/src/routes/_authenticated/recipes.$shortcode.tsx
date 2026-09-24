import { nutritionBasis as nutritionBasisSchema } from "@cubby/schemas/nutrition";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import {
  createFileRoute,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { z } from "zod";

import { GenericEntityDetail } from "~/app/_components/entity-detail/generic-entity-detail";
import EditRecipeForm from "~/app/_components/recipe/edit-recipe";
import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import type { EntityDetailByEntity } from "~/entities/generated/entity-details.gen";
import { shortcodeHead } from "~/lib/page-title";

/**
 * Hand-written because the workflow slot's state (`view`, `scale`,
 * `nutritionBasis`, `flowLayout`, `costingGap`) and the page-level `edit`
 * mode are URL keys the generic detail route has no search schema for.
 */
const searchSchema = z.object({
  nutritionBasis: nutritionBasisSchema.optional().catch(undefined),
  costingGap: z.boolean().optional().catch(undefined),
  edit: z.boolean().optional().catch(undefined),
  // The enum accepts the four current views PLUS the five legacy names so old
  // bookmarks/links don't get stripped; `remapLegacyView` normalizes a legacy
  // value at render time.
  view: z
    .enum([
      "read",
      "spec",
      "data",
      "prep",
      "flow",
      "magazine",
      "table",
      "charts",
      "nested",
      "matrix",
    ])
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
  entity: "recipe",
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
