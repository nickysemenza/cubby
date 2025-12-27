import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InventoryDetail } from "~/app/_components/inventory/inventory-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/inventory/$id")({
  component: InventoryDetailPage,
  errorComponent: RouteErrorComponent,
});

function InventoryDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();

  const {
    data: inventory,
    isLoading,
    error,
  } = useQuery(api.inventoryItem.getByID.queryOptions({ id }));

  useDocumentTitle(inventory?.product?.name);

  if (isLoading) {
    return (
      <PageWrapper>
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
        </div>
      </PageWrapper>
    );
  }

  if (error) {
    return (
      <PageWrapper>
        <div className="text-destructive">
          Error loading inventory: {error.message}
        </div>
      </PageWrapper>
    );
  }

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
