import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { USDAFoodDetail } from "~/app/_components/usda/USDAFoodDetail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { authMiddleware } from "~/lib/protected-route";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/usda/$id")({
  ssr: false,
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(
      context.trpc.usda.getByID.queryOptions({ id: parseInt(params.id, 10) }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: USDAFoodDetailPage,
  server: {
    middleware: [authMiddleware],
  },
});

function USDAFoodDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const numericId = parseInt(id, 10);

  const { data: food } = useQuery(
    api.usda.getByID.queryOptions({ id: numericId }),
  );

  useDocumentTitle(
    food?.foodInfo.description
      ? `USDA: ${food.foodInfo.description}`
      : undefined,
  );

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
