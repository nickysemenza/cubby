import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { RouteErrorComponent } from "~/components/route-error";
import { Skeleton } from "~/components/ui/skeleton";
import { useDocumentTitle } from "~/hooks/useDocumentTitle";
import { useTRPC } from "~/trpc/react";

export const Route = createFileRoute("/locations/$id")({
  component: LocationDetailPage,
  errorComponent: RouteErrorComponent,
});

function LocationDetailPage() {
  const { id } = Route.useParams();
  const api = useTRPC();

  const {
    data: location,
    isLoading,
    error,
  } = useQuery(api.location.getByID.queryOptions({ id }));

  useDocumentTitle(location?.name);

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
          Error loading location: {error.message}
        </div>
      </PageWrapper>
    );
  }

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
