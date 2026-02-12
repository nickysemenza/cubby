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
import EditRecipeForm from "~/app/_components/recipe/edit-recipe";
import RecipeDetail from "~/app/_components/recipe/RecipeDetail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";

const searchSchema = z.object({
  edit: z.boolean().optional().catch(undefined),
});

const searchDefaults = { edit: undefined } as const;

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
    <PageWrapper>
      <div>Recipe not found</div>
    </PageWrapper>
  ),
  component: RecipeDetailPage,
});

function RecipeDetailPage() {
  const { id } = Route.useParams();
  const { edit: isEditing } = Route.useSearch();
  const navigate = useNavigate();
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
    invalidateKeys: [[queryKeys.recipe.list]],
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
    <PageWrapper>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold text-2xl">{recipe.name}</h1>
        <div className="flex gap-2">
          {!isEditing ? (
            <>
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
          )}
        </div>
      </div>

      {isEditing ? (
        <EditRecipeForm recipe={recipe} onCancel={stopEditing} />
      ) : (
        <RecipeDetail recipe={recipe} />
      )}

      <DeleteDialog />
    </PageWrapper>
  );
}
