import { api } from "~/trpc/server";
import RecipeDetail from "~/app/_components/RecipeDetail";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = (await params).id;
  const recipe = await api.recipe.get({ id });
  console.log({ recipe });
  return (
    <div>
      <RecipeDetail recipe={recipe} />
    </div>
  );
}
