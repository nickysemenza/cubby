import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ProductDetail } from "~/app/_components/products/product-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/products/$id")({
  ssr: false,
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(
      context.trpc.product.getByID.queryOptions({ id: params.id }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: ProductDetailPage,
  server: {
    middleware: [authMiddleware],
  },
});

function ProductDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: product } = useQuery(api.product.getByID.queryOptions({ id }));

  useDocumentTitle(product?.name);

  if (!product) {
    return (
      <PageWrapper>
        <div>Product not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <ProductDetail product={product} />
    </PageWrapper>
  );
}
