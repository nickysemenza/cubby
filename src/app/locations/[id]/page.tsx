import { PillLink } from "~/app/_components/EntityPill";
import JsonRenderer from "~/app/_components/json";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { collectInfiniteParents } from "~/schemas/locations";
import { api } from "~/trpc/server";

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

  const parentHierarchy = collectInfiniteParents(location);

  const breadCrumbItems = parentHierarchy
    .map((parentLocation) => (
      <>
        <BreadcrumbSeparator />
        <BreadcrumbItem key={parentLocation.id}>
          <BreadcrumbLink href={`/locations/${parentLocation.id}`}>
            {parentLocation.name}
          </BreadcrumbLink>
        </BreadcrumbItem>
      </>
    ))
    .reverse();
  return (
    <div>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          {breadCrumbItems}
        </BreadcrumbList>
      </Breadcrumb>

      <h1>{location.name}</h1>

      {location.children.map((child) => (
        <div key={child.id}>
          <PillLink
            text={child.name}
            label="location"
            href={`locations/${child.id}`}
          />
        </div>
      ))}
      <JsonRenderer input={location} />
    </div>
  );
}
