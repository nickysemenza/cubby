import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { DetailPagePending } from "~/components/route-pending";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";

export const Route = createFileRoute("/locations/$id")({
  ssr: false,
  loader: ({ params, context }) =>
    context.queryClient.ensureQueryData(
      context.trpc.location.getByID.queryOptions({ id: params.id }),
    ),
  pendingComponent: DetailPagePending,
  errorComponent: RouteErrorComponent,
  component: LocationDetailPage,
});

function LocationDetailPage() {
  const { id } = Route.useParams();
  const { trpc } = Route.useRouteContext();
  const { data: location } = useQuery(
    trpc.location.getByID.queryOptions({ id }),
  );

  useDocumentTitle(location?.name);

  if (!location) {
    return (
      <PageWrapper>
        <div>Location not found</div>
      </PageWrapper>
    );
  }

  return (
    <PageWrapper>
      <LocationDetail location={location} />
    </PageWrapper>
  );
}
