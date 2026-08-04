import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import { RouteErrorComponent } from "~/components/lazy-route-error";
import { Page } from "~/components/page/Page";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDetailTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/integrations/trpc/react";
import { shortcodeHead } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/locations/$shortcode")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.location.getByShortcode.queryOptions({
        shortcode: params.shortcode,
      }),
    );
    if (!data) throw notFound();
  },
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  notFoundComponent: () => (
    <Page variant="list" title="Location not found" entity="location" compact>
      <Empty>
        <EmptyTitle>Location not found</EmptyTitle>
        <EmptyDescription>
          This storage location is no longer available.
        </EmptyDescription>
      </Empty>
    </Page>
  ),
  head: shortcodeHead,
  component: LocationDetailPage,
});

function LocationDetailPage() {
  const { shortcode } = Route.useParams();
  const api = useTRPC();
  const { data: location } = useSuspenseQuery(
    api.location.getByShortcode.queryOptions({ shortcode }),
  );

  useDetailTitle(shortcode, location?.name);

  // The loader already threw notFound for an unknown code; this guard only
  // satisfies the nullable output type.
  if (!location) return null;

  return <LocationDetail key={shortcode} location={location} />;
}
