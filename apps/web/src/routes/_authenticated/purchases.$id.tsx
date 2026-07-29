import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PurchaseDetail } from "~/app/purchases/purchase-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { purchaseLabel } from "~/lib/purchase-label";

export const Route = createFileRoute("/_authenticated/purchases/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    // `purchase.getByID` takes the id as a BARE scalar, not `{ id }` (see
    // routers/purchase.ts). No branding needed: a branded zod schema's INPUT
    // type is plain `string`.
    const data = await context.queryClient.ensureQueryData(
      context.trpc.purchase.getByID.queryOptions(params.id),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Charge not found" entity="purchase" compact>
      <Empty>
        <EmptyTitle>Charge not found</EmptyTitle>
        <EmptyDescription>This charge is no longer available.</EmptyDescription>
      </Empty>
    </Page>
  ),
  component: PurchaseDetailPage,
});

function PurchaseDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: purchase } = useSuspenseQuery(
    api.purchase.getByID.queryOptions(id),
  );

  useDocumentTitle(purchaseLabel(purchase));

  return <PurchaseDetail key={id} purchase={purchase} />;
}
