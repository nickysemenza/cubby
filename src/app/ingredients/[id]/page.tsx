import JsonRenderer from "~/app/_components/json-renderer";
import { api } from "~/trpc/server";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };
export async function generateMetadata({ params }: PageParams) {
  const id = (await params).id;
  const ingredient = await api.ingredient.getByID({ id });
  return {
    title: `Ingredient | ${ingredient.name}`,
  };
}
export default async function Page({ params }: PageParams) {
  const id = (await params).id;
  const ingredient = await api.ingredient.getByID({ id });
  return (
    <div>
      <JsonRenderer input={ingredient} />
    </div>
  );
}
