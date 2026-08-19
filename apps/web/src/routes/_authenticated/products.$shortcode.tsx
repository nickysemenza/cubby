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

const PRODUCT_SSR_TIMING = "cubby-product-ssr";

export const Route = createFileRoute("/_authenticated/products/$shortcode")({
  loader: async ({ params, context }) => {
    const startedAt = import.meta.env.SSR ? performance.now() : null;
    // No SSR-only transport swap needed: the shared tRPC client already uses
    // the in-process link during a server render (trpc-transport-isomorphic).
    const data = await context.queryClient.ensureQueryData(
      context.trpc.product.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!data) throw notFound();

    return {
      // This is end-to-end loader latency, not Worker CPU time: workerd clocks
      // do not advance during synchronous CPU-only work.
      serverTiming:
        startedAt === null
          ? undefined
          : `${PRODUCT_SSR_TIMING};dur=${(performance.now() - startedAt).toFixed(1)};desc="Product detail SSR"`,
    };
  },
  headers: ({ loaderData }) =>
    loaderData?.serverTiming
      ? { "Server-Timing": loaderData.serverTiming }
      : undefined,
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

  // ProductDetail renders its own <Page> shell (which owns the page container).
  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!product) return null;

  return <ProductDetail key={shortcode} product={product} />;
}
