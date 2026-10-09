import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { USDAFoodDetail } from "~/features/usda/USDAFoodDetail";
import { usdaFood } from "~/integrations/tanstack-query/generated/usda.gen";
import { pageTitle } from "~/lib/page-title";
import { Page } from "~/ui/page/Page";
import { Empty, EmptyDescription, EmptyTitle } from "~/ui/primitives/empty";
import { RouteErrorComponent } from "~/ui/route-error";
import { DetailPagePending } from "~/ui/route-pending";

export const Route = createFileRoute("/_authenticated/usda/$id")({
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      usdaFood.detail.queryOptions({ id: parseInt(params.id, 10) }),
    );
    if (!data) throw notFound();
    return { description: data.foodInfo.description };
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="USDA food not found" entity="usda-food" compact>
      <Empty>
        <EmptyTitle>USDA food not found</EmptyTitle>
        <EmptyDescription>
          This USDA food record is not available in Cubby.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  head: ({ params, loaderData }) => ({
    meta: [
      {
        title: pageTitle(
          loaderData?.description
            ? `USDA: ${loaderData.description}`
            : `USDA ${params.id}`,
        ),
      },
    ],
  }),
  component: USDAFoodDetailPage,
});

function USDAFoodDetailPage() {
  const { id } = Route.useParams();
  const numericId = parseInt(id, 10);

  const { data: food } = useSuspenseQuery(
    usdaFood.detail.queryOptions({ id: numericId }),
  );

  // Loader throws notFound() for null — guaranteed non-null at runtime
  if (!food) throw notFound();

  return <USDAFoodDetail id={numericId} food={food} />;
}
