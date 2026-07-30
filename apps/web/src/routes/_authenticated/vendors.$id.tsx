import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { VendorDetail } from "~/app/vendors/vendor-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/vendors/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    // `vendor.getByID` takes the branded id as a bare scalar (its router is
    // hand-rolled, not crud-factory), so no `{ id }` wrapper here.
    const data = await context.queryClient.ensureQueryData(
      context.trpc.vendor.getByID.queryOptions(params.id),
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
  component: VendorDetailPage,
});

function VendorDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: vendor } = useSuspenseQuery(
    api.vendor.getByID.queryOptions(id),
  );

  useDocumentTitle(vendor.name);

  return <VendorDetail key={id} vendor={vendor} />;
}
