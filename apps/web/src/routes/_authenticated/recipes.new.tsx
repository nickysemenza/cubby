import { createFileRoute } from "@tanstack/react-router";
import NewRecipe from "~/app/_components/recipe/new-recipe";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/recipes/new")({
  component: NewRecipePage,
});

function NewRecipePage() {
  return (
    <PageWrapper>
      <NewRecipe />
    </PageWrapper>
  );
}
