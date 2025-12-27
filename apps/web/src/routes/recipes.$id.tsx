import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import RecipeDetail from "~/app/_components/recipe/RecipeDetail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/recipes/$id")({
  component: RecipeDetailPage,
  errorComponent: RouteErrorComponent,
});

function RecipeDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();

  const {
    data: recipe,
    isLoading,
    error,
  } = useQuery(api.recipe.getByID.queryOptions({ id }));

  useDocumentTitle(recipe?.name ? `Recipe: ${recipe.name}` : undefined);

  if (isLoading) {
    return (
      <PageWrapper>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </div>
      </PageWrapper>
    );
  }

  if (error) {
    return (
      <PageWrapper>
        <div className="text-destructive">
          Error loading recipe: {error.message}
        </div>
      </PageWrapper>
    );
  }

  if (!recipe) {
    return (
      <PageWrapper>
        <div>Recipe not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <RecipeDetail recipe={recipe} />
    </PageWrapper>
  );
}
