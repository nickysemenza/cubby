import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PurchaseDetail } from "~/app/purchases/purchase-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/purchases/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.purchase.getByID.queryOptions({ id: params.id }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Purchase not found" entity="purchase" compact>
      <Empty>
        <EmptyTitle>Purchase not found</EmptyTitle>
        <EmptyDescription>
          This purchase is no longer available.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  component: PurchaseDetailPage,
});

function PurchaseDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: purchase } = useSuspenseQuery(
    api.purchase.getByID.queryOptions({ id }),
  );

  useDocumentTitle(purchase.name);

  return <PurchaseDetail key={id} purchase={purchase} />;
}
