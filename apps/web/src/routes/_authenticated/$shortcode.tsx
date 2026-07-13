/**
 * Shortcode landing route
 *
 * Handles URLs like /L-A3F2, /P-X7K9, or /R-Y8M3 from QR-code labels.
 *
 * - **Location** shortcodes render a phone-first scan landing (see
 *   {@link LocationScanLanding}) — a scanned bin QR is a physical entry point
 *   ("what's in here / add something here"), not a cue to open the full desktop
 *   detail page.
 * - **Product** and **recipe** shortcodes redirect to their detail pages.
 */

import { parseShortcode } from "@cubby/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { LocationScanLanding } from "~/app/_components/locations/location-scan-landing";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const { shortcode } = params;

    // Parse shortcode to determine entity type
    const parsed = parseShortcode(shortcode);
    if (!parsed) {
      // Not a valid shortcode format - show 404
      throw notFound();
    }

    // Location: resolve and render the scan landing (no redirect). Prime the
    // same query the component reads so it hydrates without a second fetch.
    if (parsed.type === "location") {
      const location = await context.queryClient.ensureQueryData(
        context.trpc.location.getByShortcode.queryOptions({ shortcode }),
      );
      if (!location) throw notFound();
      return;
    }

    if (parsed.type === "product") {
      const product = await context.queryClient.fetchQuery(
        context.trpc.product.getByShortcode.queryOptions({ shortcode }),
      );
      if (!product) throw notFound();
      throw redirect({
        to: "/products/$id",
        params: { id: product.id },
        replace: true,
      });
    }

    if (parsed.type === "recipe") {
      const recipe = await context.queryClient.fetchQuery(
        context.trpc.recipe.getByShortcode.queryOptions({ shortcode }),
      );
      if (!recipe) throw notFound();
      throw redirect({
        to: "/recipes/$id",
        params: { id: recipe.id },
        replace: true,
      });
    }

    // Should never reach here (parseShortcode only yields the three types).
    throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Not found" compact>
      <Empty>
        <EmptyTitle>Nothing found for that code</EmptyTitle>
        <EmptyDescription>
          This QR label doesn't match a location, product, or recipe.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  component: ShortcodeLandingPage,
});

function ShortcodeLandingPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  // The loader only reaches this component for a location shortcode
  // (product/recipe throw redirect) and has already primed this query.
  const { data: location } = useSuspenseQuery(
    api.location.getByShortcode.queryOptions({ shortcode }),
  );

  if (!location) return null;

  return <LocationScanLanding key={location.id} location={location} />;
}
