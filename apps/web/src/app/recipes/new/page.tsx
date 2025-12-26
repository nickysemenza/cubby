import type { Metadata } from "next";
import NewRecipeForm from "~/app/_components/recipe/new-recipe";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const metadata: Metadata = {
  title: "New Recipe",
};

export default function Page() {
  return (
    <PageWrapper>
      <h1 className="mb-6 font-bold text-2xl">Create New Recipe</h1>
      <NewRecipeForm />
    </PageWrapper>
  );
}
