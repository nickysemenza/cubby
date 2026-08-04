import type { RecipeOut } from "@cubby/schemas/recipe";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  notFound,
  stripSearchParams,
  useNavigate,
} from "@tanstack/react-router";
import { Edit, X } from "lucide-react";
import { z } from "zod";
import { useEntityDelete } from "~/app/_components/hooks/useEntityDelete";
import { CopyRecipeParseButton } from "~/app/_components/recipe/copy-corpus-button";
import EditRecipeForm from "~/app/_components/recipe/edit-recipe";
import { RecipeAvailabilityPanel } from "~/app/_components/recipe/RecipeAvailabilityPanel";
import RecipeDetail, {
  type RecipeViewMode,
  remapLegacyView,
} from "~/app/_components/recipe/RecipeDetail";
import type { RecipeFlowLayoutMode } from "~/app/_components/recipe/RecipeFlowView";
import { AddToMeal } from "~/app/meals/add-to-meal";
import { Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";
import { recipeMutationInvalidateKeys } from "~/lib/query-keys";
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

export const Route = createFileRoute("/_authenticated/recipes/$shortcode")({
  ssr: false,
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.recipe.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Recipe not found" entity="recipe" compact>
      <Empty>
        <EmptyTitle>Recipe not found</EmptyTitle>
        <EmptyDescription>This recipe is no longer available.</EmptyDescription>
      </Empty>
    </Page>
  ),
  head: shortcodeHead,
  component: RecipeDetailPage,
});

/**
 * Splits the guard from the body so every hook below can treat the recipe as
 * loaded. The loader already threw notFound for an unknown code; this only
 * satisfies `getByShortcode`'s nullable output, and inlining the guard would
 * mean either a conditional hook or `?.` on a dozen call sites.
 */
function RecipeDetailPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: recipe } = useSuspenseQuery(
    api.recipe.getByShortcode.queryOptions({ shortcode }),
  );
  if (!recipe) return null;
  return <RecipeDetailBody recipe={recipe} />;
}

function RecipeDetailBody({ recipe }: { recipe: RecipeOut }) {
  const { shortcode } = Route.useParams();
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
  const api = useTRPC();

  const { deleteButton, deleteDialog } = useEntityDelete({
    id: recipe.id,
    name: recipe.name,
    entityLabel: "Recipe",
    entity: "recipe",
    mutationOptions: (callbacks) =>
      api.recipe.delete.mutationOptions(callbacks),
    invalidateKeys: recipeMutationInvalidateKeys,
    redirectTo: "/recipes",
  });

  useDetailTitle(shortcode, recipe.name);

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

  return (
    <Page
      variant="detail"
      entity="recipe"
      title={recipe.name}
      rawData={recipe}
      heroStats={heroStats.length > 0 ? heroStats : undefined}
      actions={
        !isEditing ? (
          <>
            <AddToMeal recipeId={recipe.id} />
            <CopyRecipeParseButton recipe={recipe} />
            <Button onClick={startEditing} variant="outline" size="sm">
              <Edit />
              Edit Recipe
            </Button>
            {deleteButton}
          </>
        ) : (
          <Button onClick={stopEditing} variant="outline" size="sm">
            <X />
            Cancel
          </Button>
        )
      }
    >
      {isEditing ? (
        <EditRecipeForm recipe={recipe} onCancel={stopEditing} />
      ) : (
        <Stack gap="lg">
          {/* Inventory cross-check — its own query/skeleton, so the recipe
              never waits on the availability engine. Lives here rather than in
              RecipeDetail so the search hover-preview (which embeds
              RecipeDetail) doesn't fire it. */}
          <RecipeAvailabilityPanel recipeId={recipe.id} />
          <RecipeDetail
            recipe={recipe}
            view={recipeView}
            onViewChange={setRecipeView}
            scale={scale}
            onScaleChange={setScale}
            flowLayout={flowLayout}
            onFlowLayoutChange={setFlowLayout}
          />
        </Stack>
      )}

      {deleteDialog}
    </Page>
  );
}
