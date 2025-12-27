import { api } from "~/trpc/server";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import {
  LocationBreadcrumb,
  locationToSegments,
} from "~/app/_components/locations/location-breadcrumb";
import { PageWrapper } from "~/components/layout/page-wrapper";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };

export async function generateMetadata({ params }: PageParams) {
  const id = (await params).id;
  const location = await api.location.getByID({ id });
  return {
    title: `Location | ${location.name}`,
  };
}

export default async function Page({ params }: PageParams) {
  const id = (await params).id;
  const location = await api.location.getByID({ id });

  return (
    <PageWrapper>
      <LocationBreadcrumb
        segments={locationToSegments(location)}
        linkable
        showHome
        className="mb-4"
      />
      <LocationDetail location={location} />
    </PageWrapper>
  );
}
