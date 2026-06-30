import { createFileRoute } from "@tanstack/react-router";
import NewRecipe from "~/app/_components/recipe/new-recipe";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/recipes/new")({
  component: NewRecipePage,
});

function NewRecipePage() {
  return (
    <Page variant="list" title="New recipe" compact>
      <NewRecipe />
    </Page>
  );
}
