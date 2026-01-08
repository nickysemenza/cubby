import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { IngredientDetail } from "~/app/_components/ingredients/ingredient-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/ingredients/$id")({
  ssr: false,
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(
      context.trpc.ingredient.getByID.queryOptions({ id: params.id }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: IngredientDetailPage,
});

function IngredientDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: ingredient } = useQuery(
    api.ingredient.getByID.queryOptions({ id }),
  );

  useDocumentTitle(ingredient?.name);

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
