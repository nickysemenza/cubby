import { api } from "~/trpc/server";
import { LocationDetail } from "~/app/_components/locations/location-detail";
import {
  BreadcrumbSeparator,
  BreadcrumbItem,
  BreadcrumbLink,
  Breadcrumb,
  BreadcrumbList,
} from "~/components/ui/breadcrumb";
import { collectInfiniteParents } from "~/schemas/location";
import Link from "next/link";

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
    <div>
      <Breadcrumb className="p-6">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {collectInfiniteParents(location)
            .reverse()
            .map((parentLocation) => (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem key={parentLocation.id}>
                  <BreadcrumbLink asChild>
                    <Link href={`/locations/${parentLocation.id}`}>
                      {parentLocation.name}
                    </Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
              </>
            ))}
          <BreadcrumbSeparator />
          <BreadcrumbItem>{location.name}</BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <LocationDetail location={location} />
    </div>
  );
}
