/**
 * Shortcode landing route — the compact URL a QR label or a typed code lands on.
 *
 * Handles `/LOC-A3F2`, `/PRD-X7K9`, and every other prefix, plus the pre-cutover
 * single-letter forms (`/L-A3F2`) that are printed on labels already stuck to
 * things. `parseShortcode` canonicalizes those, so a legacy scan ends up at the
 * same canonical URL as a fresh one — never at a uuid.
 *
 * - **Location** codes render a phone-first scan landing in place (see
 *   {@link LocationScanLanding}) — a scanned bin QR is a physical entry point
 *   ("what's in here / add something here"), not a cue to open the full desktop
 *   detail page.
 * - **Everything else** redirects to its entity-scoped detail URL. That needs no
 *   lookup at all: the prefix alone names the entity, and the detail route does
 *   its own 404 if the code turns out to be unknown.
 */

import { parseShortcode } from "@cubby/shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { LocationScanLanding } from "~/app/_components/locations/location-scan-landing";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { entities, entityDetailParams } from "~/entities/entities";
import { useTRPC } from "~/integrations/trpc/react";

export const Route = createFileRoute("/_authenticated/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const parsed = parseShortcode(params.shortcode);
    if (!parsed) throw notFound();

    if (parsed.type === "location") {
      // Prime the same query the component reads so it hydrates without a
      // second fetch.
      const location = await context.queryClient.ensureQueryData(
        context.trpc.location.getByShortcode.queryOptions({
          shortcode: parsed.shortcode,
        }),
      );
      if (!location) throw notFound();
      return;
    }

    throw redirect({
      to: entities[parsed.type].routes.detail,
      params: entityDetailParams(parsed.shortcode),
      replace: true,
    });
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Not found" compact>
      <Empty>
        <EmptyTitle>Nothing found for that code</EmptyTitle>
        <EmptyDescription>
          This QR label doesn't match anything in Cubby.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  component: ShortcodeLandingPage,
});

function ShortcodeLandingPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  // The loader only reaches this component for a location shortcode (everything
  // else throws redirect) and has already primed this query.
  const { data: location } = useSuspenseQuery(
    api.location.getByShortcode.queryOptions({ shortcode }),
  );

  if (!location) return null;

  return <LocationScanLanding key={location.id} location={location} />;
}
