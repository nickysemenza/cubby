import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { IngredientDetail } from "~/app/_components/ingredients/ingredient-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
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
    <Page
      variant="list"
      title="Ingredient not found"
      entity="ingredient"
      compact
    >
      <Empty>
        <EmptyTitle>Ingredient not found</EmptyTitle>
        <EmptyDescription>
          This ingredient is no longer available.
        </EmptyDescription>
      </Empty>
    </Page>
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
