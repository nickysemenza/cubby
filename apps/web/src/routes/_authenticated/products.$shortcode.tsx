import { createFileRoute } from "@tanstack/react-router";
import { ProductDetail } from "~/app/_components/products/product-detail";
import { ensureDetailRecord } from "~/app/_components/routing/detail-loader";
import {
  detailPage,
  notFoundPage,
} from "~/app/_components/routing/entity-routes";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { DetailPagePending } from "~/components/route-pending";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { shortcodeHead } from "~/lib/page-title";

const PRODUCT_SSR_TIMING = "cubby-product-ssr";

// Bound to consts, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const ProductDetailPage = detailPage({
  query: (shortcode) => entityDetailFor("product").queryOptions(shortcode),
  // ProductDetail renders its own <Page> shell (which owns the page container).
  render: (product, shortcode) => (
    <ProductDetail key={shortcode} product={product} />
  ),
  title: (product) => product.name,
});

const ProductNotFound = notFoundPage(
  "product",
  "Product not found",
  "This catalog product is no longer available.",
);

export const Route = createFileRoute("/_authenticated/products/$shortcode")({
  loader: async ({ params, context }) => {
    const startedAt = import.meta.env.SSR ? performance.now() : null;
    // The Start function is the same detail boundary during SSR and hydration.
    await ensureDetailRecord(
      context.queryClient,
      entityDetailFor("product").queryOptions(params.shortcode),
    );

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
  notFoundComponent: ProductNotFound,
  head: shortcodeHead,
  component: ProductDetailPage,
});
