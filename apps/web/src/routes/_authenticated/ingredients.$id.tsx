import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { IngredientDetail } from "~/app/_components/ingredients/ingredient-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/ingredients/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.ingredient.getByID.queryOptions({ id: params.id }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <PageWrapper>
      <div>Ingredient not found</div>
    </PageWrapper>
  ),
  component: IngredientDetailPage,
});

function IngredientDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: ingredient } = useSuspenseQuery(
    api.ingredient.getByID.queryOptions({ id }),
  );

  useDocumentTitle(ingredient.name);

  return <IngredientDetail key={id} ingredient={ingredient} />;
}
