import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { IngredientDetail } from "~/app/_components/ingredients/ingredient-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/ingredients/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.ingredient.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
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
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: ingredient } = useSuspenseQuery(
    api.ingredient.getByShortcode.queryOptions({ shortcode }),
  );

  useDocumentTitle(ingredient?.name);

  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!ingredient) return null;

  return <IngredientDetail key={shortcode} ingredient={ingredient} />;
}
