import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { USDAFoodDetail } from "~/app/_components/usda/USDAFoodDetail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/usda/$id")({
  component: USDAFoodDetailPage,
  errorComponent: RouteErrorComponent,
});

function USDAFoodDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const numericId = parseInt(id, 10);

  const {
    data: food,
    isLoading,
    error,
  } = useQuery(api.usda.getByID.queryOptions({ id: numericId }));

  useDocumentTitle(
    food?.foodInfo.description
      ? `USDA: ${food.foodInfo.description}`
      : undefined,
  );

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
          Error loading USDA food: {error.message}
        </div>
      </PageWrapper>
    );
  }

  if (!food) {
    return (
      <PageWrapper>
        <div>USDA food not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <USDAFoodDetail id={numericId} food={food} />
    </PageWrapper>
  );
}
