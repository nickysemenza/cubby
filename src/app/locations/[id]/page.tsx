import JsonRenderer from "~/app/_components/json";
import { api } from "~/trpc/server";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };
export async function generateMetadata({ params }: PageParams) {
  const id = (await params).id;
  const item = await api.location.getByID({ id });
  return {
    title: `Location | ${item.name}`,
  };
}
export default async function Page({ params }: PageParams) {
  const id = (await params).id;
  const item = await api.location.getByID({ id });
  return (
    <div>
      <JsonRenderer input={item} />
    </div>
  );
}
