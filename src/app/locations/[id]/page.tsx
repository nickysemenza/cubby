import { api } from "~/trpc/server";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import { EnhancedBreadcrumbs } from "~/app/_components/locations/enhanced-breadcrumbs";
import { PageWrapper } from "~/components/ui/page-wrapper";

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
      <EnhancedBreadcrumbs location={location} className="mb-4" />
      <LocationDetail location={location} />
    </PageWrapper>
  );
}
