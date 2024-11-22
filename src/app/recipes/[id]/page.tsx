import { api } from "~/trpc/server";
import RecipeDetail from "~/app/_components/RecipeDetail";

type DetailParams = { id: string };
type PageParams = { params: Promise<DetailParams> };
export async function generateMetadata({ params }: PageParams) {
  const id = (await params).id;
  const recipe = await api.recipe.get({ id });
  return {
    title: `Recipe | ${recipe.name}`,
  };
}
export default async function Page({ params }: PageParams) {
  const id = (await params).id;
  const recipe = await api.recipe.get({ id });
  console.log({ recipe });
  return (
    <div>
      <RecipeDetail recipe={recipe} />
    </div>
  );
}
