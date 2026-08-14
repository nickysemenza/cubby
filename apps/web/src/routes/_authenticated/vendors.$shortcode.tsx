import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { VendorDetail } from "~/app/vendors/vendor-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/vendors/$shortcode")({
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.vendor.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Vendor not found" entity="vendor" compact>
      <Empty>
        <EmptyTitle>Vendor not found</EmptyTitle>
        <EmptyDescription>This vendor is no longer available.</EmptyDescription>
      </Empty>
    </Page>
  ),
  head: shortcodeHead,
  component: VendorDetailPage,
});

function VendorDetailPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: vendor } = useSuspenseQuery(
    api.vendor.getByShortcode.queryOptions({ shortcode }),
  );

  useDetailTitle(shortcode, vendor?.name);

  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!vendor) return null;

  return <VendorDetail key={shortcode} vendor={vendor} />;
}
