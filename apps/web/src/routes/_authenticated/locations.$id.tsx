import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import { Page } from "~/components/page/Page";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/_authenticated/locations/$id")({
  ssr: false,
  loader: async ({ params, context }) => {
    const data = await context.queryClient.ensureQueryData(
      context.trpc.location.getByID.queryOptions({ id: params.id }),
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
  component: LocationDetailPage,
});

function LocationDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();
  const { data: location } = useSuspenseQuery(
    api.location.getByID.queryOptions({ id }),
  );

  useDocumentTitle(location.name);

  return <LocationDetail key={id} location={location} />;
}
