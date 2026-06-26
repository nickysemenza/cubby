import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ProductDetail } from "~/app/_components/products/product-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/products/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.product.getByID.queryOptions({ id: params.id }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Product not found" entity="product" compact>
      <Empty>
        <EmptyTitle>Product not found</EmptyTitle>
        <EmptyDescription>
          This catalog product is no longer available.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  component: ProductDetailPage,
});

function ProductDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: product } = useSuspenseQuery(
    api.product.getByID.queryOptions({ id }),
  );

  useDocumentTitle(product.name);

  // ProductDetail renders its own <Page> shell (which owns the PageWrapper).
  return <ProductDetail key={id} product={product} />;
}
