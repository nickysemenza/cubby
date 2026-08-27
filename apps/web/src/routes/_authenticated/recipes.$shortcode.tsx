import type { RecipeOut } from "@cubby/schemas/recipe";
import {
  createFileRoute,
  notFound,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Edit, PackageCheck, X } from "lucide-react";
import { z } from "zod";
import { VerbButton } from "~/app/_components/actions/action-verb-ui";
import type { DetailSection } from "~/app/_components/data-table/detail-page";
import { useEntityDelete } from "~/app/_components/hooks/useEntityDelete";
import { CopyRecipeParseButton } from "~/app/_components/recipe/copy-corpus-button";
import EditRecipeForm from "~/app/_components/recipe/edit-recipe";
import { RecipeAvailabilityPanel } from "~/app/_components/recipe/RecipeAvailabilityPanel";
import RecipeDetail, {
  type RecipeViewMode,
  remapLegacyView,
} from "~/app/_components/recipe/RecipeDetail";
import type { RecipeFlowLayoutMode } from "~/app/_components/recipe/RecipeFlowView";
import { useDuplicateRecipe } from "~/app/_components/recipe/use-duplicate-recipe";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { AddToMeal } from "~/app/meals/add-to-meal";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { entityDetailQueryOptions } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";
import { formatCurrency } from "~/lib/utils";

const searchSchema = z.object({
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
  flowLayout: z.enum(["map", "table"]).optional().catch(undefined),
  // Scaling is purely derived/display state, kept in the URL so a scaled view is
  // shareable and printable. `scale` is the resolved factor (absent = 1×).
  scale: z.number().positive().optional().catch(undefined),
});

const searchDefaults = {
  edit: undefined,
  view: undefined,
  flowLayout: undefined,
  scale: undefined,
} as const;

const RecipeNotFound = notFoundPage(
  "recipe",
  "Recipe not found",
  "This recipe is no longer available.",
);

const RecipeDetailPage = detailPage({
  query: (shortcode) => entityDetailQueryOptions("recipe", shortcode),
  render: (recipe) => <RecipeDetailBody recipe={recipe} />,
  title: (recipe) => recipe.name,
});

export const Route = createFileRoute("/_authenticated/recipes/$shortcode")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      entityDetailQueryOptions("recipe", params.shortcode),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: RecipeNotFound,
  head: shortcodeHead,
  component: RecipeDetailPage,
});

function RecipeDetailBody({ recipe }: { recipe: RecipeOut }) {
  const { edit: isEditing, view, flowLayout, scale } = Route.useSearch();
  const navigate = useNavigate();

  // Normalize the (possibly legacy) URL view into a current view.
  const recipeView = remapLegacyView(view);

  const setRecipeView = (next: RecipeViewMode) => {
    // Keep the default ("read") out of the URL for clean links.
    navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        view: next === "read" ? undefined : next,
      }),
    });
  };

  const setScale = (factor: number) => {
    // Strip the default (1×) so unscaled links stay clean.
    navigate({
      to: ".",
      search: (prev) => ({ ...prev, scale: factor === 1 ? undefined : factor }),
    });
  };
  const setFlowLayout = (next: RecipeFlowLayoutMode) => {
    navigate({
      to: ".",
      search: (prev) => ({ ...prev, flowLayout: next }),
    });
  };

  const { deleteButton, deleteDialog } = useEntityDelete({
    id: recipe.id,
    name: recipe.name,
    entityLabel: "Recipe",
    entity: "recipe",
    mutationOptions: (callbacks) =>
      entityMutationOptionsFactory("recipe", "delete")(callbacks),
    redirectTo: "/recipes",
  });

  const { duplicateRecipe, isPending: isDuplicating } = useDuplicateRecipe();

  // Placard stats from the persisted totals — zero engine calls. The Data
  // view's summary card shows live SCALED totals; these are the 1× ledger
  // numbers, consistent with the recipe list.
  const totals = recipe.totals;
  const heroStats: DetailHeroStat[] = [
    ...(totals
      ? [
          {
            label: "Cost",
            value:
              totals.costTotalUpper != null
                ? `${formatCurrency(totals.costTotal)}–${formatCurrency(totals.costTotalUpper)}`
                : formatCurrency(totals.costTotal),
          },
          { label: "Calories", value: Math.round(totals.caloriesTotal) },
        ]
      : []),
    ...(recipe.servings != null
      ? [{ label: "Servings", value: recipe.servings }]
      : []),
  ];

  const startEditing = () => {
    navigate({ to: ".", search: { edit: true } });
  };

  const stopEditing = () => {
    navigate({ to: ".", search: { edit: undefined } });
  };
  const routeSections: DetailSection[] = [
    {
      id: "availability",
      title: "Availability",
      icon: PackageCheck,
      placement: "full",
      // Availability owns a separate inventory query. The canonical route adds
      // it to RecipeDetail's one section ledger; embedded search previews omit
      // it so opening a preview never starts that extra read.
      content: <RecipeAvailabilityPanel recipeId={recipe.id} />,
    },
  ];

  return (
    <Page
      variant="detail"
      entity="recipe"
      title={recipe.name}
      rawData={recipe}
      heroNo={recipe.id}
      heroStats={heroStats.length > 0 ? heroStats : undefined}
      heroActions={
        !isEditing
          ? {
              primary: <AddToMeal recipeId={recipe.id} />,
              secondary: (
                <>
                  <CopyRecipeParseButton recipe={recipe} />
                  <VerbButton
                    verb="duplicate"
                    disabled={isDuplicating}
                    onClick={() => duplicateRecipe(recipe.id)}
                  />
                  <Button onClick={startEditing} variant="outline" size="sm">
                    <Edit />
                    Edit Recipe
                  </Button>
                  {deleteButton}
                </>
              ),
            }
          : {
              primary: (
                <Button onClick={stopEditing} variant="outline" size="sm">
                  <X />
                  Cancel
                </Button>
              ),
            }
      }
    >
      {isEditing ? (
        <EditRecipeForm recipe={recipe} onCancel={stopEditing} />
      ) : (
        <RecipeDetail
          recipe={recipe}
          leadingSections={routeSections}
          view={recipeView}
          onViewChange={setRecipeView}
          scale={scale}
          onScaleChange={setScale}
          flowLayout={flowLayout}
          onFlowLayoutChange={setFlowLayout}
        />
      )}

      {deleteDialog}
    </Page>
  );
}
