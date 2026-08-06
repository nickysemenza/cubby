import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ProductDetail } from "~/app/_components/products/product-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";
import { getProductDetailForSsr } from "~/lib/product-detail-server";

export const Route = createFileRoute("/_authenticated/products/$shortcode")({
  loader: async ({ params, context }) => {
    const queryOptions = context.trpc.product.getByShortcode.queryOptions({
      shortcode: params.shortcode,
    });
    const data = await context.queryClient.ensureQueryData(
      import.meta.env.SSR
        ? {
            ...queryOptions,
            // Keep the exact tRPC query key while replacing only the server's
            // transport. The result dehydrates through the existing SuperJSON
            // Query integration, so hydration sees a fresh cache hit and does
            // not repeat the detail request in the browser.
            queryFn: () =>
              getProductDetailForSsr({
                data: { shortcode: params.shortcode },
              }),
          }
        : queryOptions,
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
  head: shortcodeHead,
  component: ProductDetailPage,
});

function ProductDetailPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: product } = useSuspenseQuery(
    api.product.getByShortcode.queryOptions({ shortcode }),
  );

  useDetailTitle(shortcode, product?.name);

  // ProductDetail renders its own <Page> shell (which owns the PageWrapper).
  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!product) return null;

  return <ProductDetail key={shortcode} product={product} />;
}
