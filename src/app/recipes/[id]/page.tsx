import { api } from "~/trpc/server";
import { WasmContextProvider } from "~/wasmContext";
import RecipePageClient from "./page-client";

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

  return (
    <div className="container py-6">
      <WasmContextProvider>
        <RecipePageClient recipe={recipe} />
      </WasmContextProvider>
    </div>
  );
}
