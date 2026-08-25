import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { USDAFoodDetail } from "~/app/_components/usda/USDAFoodDetail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { usdaFoodDetailQueryOptions } from "~/entities/usda.functions";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/usda/$id")({
  // Client-only for latency: this is the one de-flagged route whose loader
  // blocks on an upstream rather than our own DB. The USDA detail projection reaches
  // usda-api over a service binding whose internal work runs ~500ms-1s (see
  // the abort ceiling in server/clients/usda.ts), and server-rendering it
  // holds the whole document for that long. A skeleton that fills in beats a
  // blank wait on a rarely-visited detail route.
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      usdaFoodDetailQueryOptions(parseInt(params.id, 10)),
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
  const numericId = parseInt(id, 10);

  const { data: food } = useSuspenseQuery(
    usdaFoodDetailQueryOptions(numericId),
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
