import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { USDAFoodDetail } from "~/app/_components/usda/USDAFoodDetail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/usda/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.usda.getByID.queryOptions({ id: parseInt(params.id, 10) }),
    );
    if (!data) throw notFound();
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
  head: ({ params }) => ({ meta: [{ title: pageTitle(`USDA ${params.id}`) }] }),
  component: USDAFoodDetailPage,
});

function USDAFoodDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const numericId = parseInt(id, 10);

  const { data: food } = useSuspenseQuery(
    api.usda.getByID.queryOptions({ id: numericId }),
  );

  // Loader throws notFound() for null — guaranteed non-null at runtime
  if (!food) throw notFound();

  useDocumentTitle(
    food.foodInfo.description
      ? `USDA: ${food.foodInfo.description}`
      : undefined,
  );

  return <USDAFoodDetail id={numericId} food={food} />;
}
