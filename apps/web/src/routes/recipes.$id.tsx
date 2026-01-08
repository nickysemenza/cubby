import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Edit, X } from "lucide-react";
import { z } from "zod";
import EditRecipeForm from "~/app/_components/recipe/edit-recipe";
import RecipeDetail from "~/app/_components/recipe/RecipeDetail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Button } from "~/components/ui/button";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

const searchSchema = z.object({
  edit: z.boolean().optional(),
});

export const Route = createFileRoute("/recipes/$id")({
  ssr: false,
  validateSearch: searchSchema,
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(
      context.trpc.recipe.getByID.queryOptions({ id: params.id }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: RecipeDetailPage,
});

function RecipeDetailPage() {
  const { id } = Route.useParams();
  const { edit: isEditing } = Route.useSearch();
  const navigate = useNavigate();
  const api = useTRPC();

  const { data: recipe } = useQuery(api.recipe.getByID.queryOptions({ id }));

  useDocumentTitle(recipe?.name ? `Recipe: ${recipe.name}` : undefined);

  const startEditing = () => {
    navigate({ to: ".", search: { edit: true } });
  };

  const stopEditing = () => {
    navigate({ to: ".", search: { edit: undefined } });
  };

  if (!recipe) {
    return (
      <PageWrapper>
        <div>Recipe not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-bold text-2xl">{recipe.name}</h1>
        {!isEditing ? (
          <Button onClick={startEditing} variant="outline" size="sm">
            <Edit className="mr-2 h-4 w-4" />
            Edit Recipe
          </Button>
        ) : (
          <Button onClick={stopEditing} variant="outline" size="sm">
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        )}
      </div>

      {isEditing ? (
        <EditRecipeForm recipe={recipe} onCancel={stopEditing} />
      ) : (
        <RecipeDetail recipe={recipe} />
      )}
    </PageWrapper>
  );
}
