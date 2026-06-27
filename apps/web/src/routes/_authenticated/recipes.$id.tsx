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
import RecipeDetail, {
  type RecipeViewMode,
  remapLegacyView,
} from "~/app/_components/recipe/RecipeDetail";
import { AddToMeal } from "~/app/meals/add-to-meal";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { recipeMutationInvalidateKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

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
      "magazine",
      "table",
      "charts",
      "nested",
      "matrix",
    ])
    .optional()
    .catch(undefined),
  // Scaling is purely derived/display state, kept in the URL so a scaled view is
  // shareable and printable. `scale` is the resolved factor (absent = 1×).
  scale: z.number().positive().optional().catch(undefined),
});

const searchDefaults = {
  edit: undefined,
  view: undefined,
  scale: undefined,
} as const;

export const Route = createFileRoute("/_authenticated/recipes/$id")({
  ssr: false,
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(searchDefaults)] },
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.recipe.getByID.queryOptions({ id: params.id }),
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
  component: RecipeDetailPage,
});

function RecipeDetailPage() {
  const { id } = Route.useParams();
  const { edit: isEditing, view, scale } = Route.useSearch();
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
  const api = useTRPC();

  const { data: recipe } = useSuspenseQuery(
    api.recipe.getByID.queryOptions({ id }),
  );

  const { DeleteButton, DeleteDialog } = useEntityDelete({
    id,
    name: recipe.name,
    entityLabel: "Recipe",
    mutationOptions: (callbacks) =>
      api.recipe.delete.mutationOptions(callbacks),
    invalidateKeys: recipeMutationInvalidateKeys,
    redirectTo: "/recipes",
  });

  useDocumentTitle(recipe.name ? `Recipe: ${recipe.name}` : undefined);

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
      actions={
        !isEditing ? (
          <>
            <AddToMeal recipeId={recipe.id} />
            <CopyRecipeParseButton recipe={recipe} />
            <Button onClick={startEditing} variant="outline" size="sm">
              <Edit className="mr-2 h-4 w-4" />
              Edit Recipe
            </Button>
            <DeleteButton size="sm" />
          </>
        ) : (
          <Button onClick={stopEditing} variant="outline" size="sm">
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        )
      }
    >
      {isEditing ? (
        <EditRecipeForm recipe={recipe} onCancel={stopEditing} />
      ) : (
        <RecipeDetail
          recipe={recipe}
          view={recipeView}
          onViewChange={setRecipeView}
          scale={scale}
          onScaleChange={setScale}
        />
      )}

      <DeleteDialog />
    </Page>
  );
}
