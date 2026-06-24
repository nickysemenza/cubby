import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { InventoryDetail } from "~/app/_components/inventory/inventory-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/inventory/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.inventory.getByID.queryOptions({ id: params.id }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <PageWrapper>
      <div>Inventory item not found</div>
    </PageWrapper>
  ),
  component: InventoryDetailPage,
});

function InventoryDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: inventory } = useSuspenseQuery(
    api.inventory.getByID.queryOptions({ id }),
  );

  useDocumentTitle(inventory.product?.name);

  return <InventoryDetail key={id} inventoryitem={inventory} />;
}
