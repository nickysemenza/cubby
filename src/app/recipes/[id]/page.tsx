import { api } from "~/trpc/server";
import RecipePageClient from "./page-client";
import { PageWrapper } from "~/components/ui/page-wrapper";

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
    <PageWrapper>
      <RecipePageClient recipe={recipe} />
    </PageWrapper>
  );
}
