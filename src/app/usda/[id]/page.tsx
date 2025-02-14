import JsonRenderer from "~/app/_components/json";
import { api } from "~/trpc/server";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };
export async function generateMetadata({ params }: PageParams) {
  const id = parseInt((await params).id);
  //   const product = await api.product.getByID({ id });
  return {
    title: `USDA FDC | ${id}`,
  };
}
export default async function Page({ params }: PageParams) {
  const id = parseInt((await params).id);
  const food = await api.usda.getByID({ id });
  return (
    <div>
      <JsonRenderer input={food} />
    </div>
  );
}
