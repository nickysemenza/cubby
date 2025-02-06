import JsonRenderer from "~/app/_components/json";
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
  return (
    <div>
      <JsonRenderer input={location} />
    </div>
  );
}
