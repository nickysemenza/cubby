import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { PurchaseDetail } from "~/app/purchases/purchase-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";
import { purchaseLabel } from "~/lib/purchase-label";

export const Route = createFileRoute("/_authenticated/purchases/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.purchase.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
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
  head: shortcodeHead,
  component: PurchaseDetailPage,
});

function PurchaseDetailPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: purchase } = useSuspenseQuery(
    api.purchase.getByShortcode.queryOptions({ shortcode }),
  );

  useDetailTitle(shortcode, purchase ? purchaseLabel(purchase) : undefined);

  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!purchase) return null;

  return <PurchaseDetail key={shortcode} purchase={purchase} />;
}
