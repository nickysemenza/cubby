import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InventoryDetail } from "~/app/_components/inventory/inventory-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";

export const Route = createFileRoute("/inventory/$id")({
  ssr: false,
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(
      context.trpc.inventory.getByID.queryOptions({ id: params.id }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: InventoryDetailPage,
});

function InventoryDetailPage() {
  const { id } = Route.useParams();
  const { trpc } = Route.useRouteContext();
  const { data: inventory } = useQuery(
    trpc.inventory.getByID.queryOptions({ id }),
  );

  useDocumentTitle(inventory?.product?.name);

  if (!inventory) {
    return (
      <PageWrapper>
        <div>Inventory item not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <InventoryDetail inventoryitem={inventory} />
    </PageWrapper>
  );
}
