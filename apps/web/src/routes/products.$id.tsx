import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ProductDetail } from "~/app/_components/products/product-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/products/$id")({
  component: ProductDetailPage,
  errorComponent: RouteErrorComponent,
});

function ProductDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();

  const {
    data: product,
    isLoading,
    error,
  } = useQuery(api.product.getByID.queryOptions({ id }));

  useDocumentTitle(product?.name);

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
          Error loading product: {error.message}
        </div>
      </PageWrapper>
    );
  }

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
