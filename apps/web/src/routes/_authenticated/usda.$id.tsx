import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { USDAFoodDetail } from "~/app/_components/usda/USDAFoodDetail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

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
    <PageWrapper>
      <div>USDA food not found</div>
    </PageWrapper>
  ),
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

  return (
    <PageWrapper>
      <USDAFoodDetail id={numericId} food={food} />
    </PageWrapper>
  );
}
