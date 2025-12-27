import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { IngredientDetail } from "~/app/_components/ingredients/ingredient-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/ingredients/$id")({
  component: IngredientDetailPage,
  errorComponent: RouteErrorComponent,
});

function IngredientDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();

  const {
    data: ingredient,
    isLoading,
    error,
  } = useQuery(api.ingredient.getByID.queryOptions({ id }));

  useDocumentTitle(ingredient?.name);

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
          Error loading ingredient: {error.message}
        </div>
      </PageWrapper>
    );
  }

  if (!ingredient) {
    return (
      <PageWrapper>
        <div>Ingredient not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <IngredientDetail ingredient={ingredient} />
    </PageWrapper>
  );
}
