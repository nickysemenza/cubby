import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ProductDetail } from "~/app/_components/products/product-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";

export const Route = createFileRoute("/products/$id")({
  ssr: false,
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(
      context.trpc.product.getByID.queryOptions({ id: params.id }),
    ),
  pendingComponent: ProductDetailPending,
  errorComponent: RouteErrorComponent,
  component: ProductDetailPage,
});

function ProductDetailPending() {
  return (
    <PageWrapper>
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    </PageWrapper>
  );
}

function ProductDetailPage() {
  const { id } = Route.useParams();
  const { trpc } = Route.useRouteContext();
  const { data: product } = useQuery(trpc.product.getByID.queryOptions({ id }));

  useDocumentTitle(product?.name);

  // Loader guarantees data exists, but handle edge case for type safety
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
