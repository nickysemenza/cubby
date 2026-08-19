import { createFileRoute } from "@tanstack/react-router";
import { IngredientList } from "~/app/ingredients/ingredientlist";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/ingredients/")({
  head: () => ({ meta: [{ title: pageTitle("Ingredients") }] }),
  component: IngredientsPage,
});

function IngredientsPage() {
  return (
    <Page variant="list" title="Ingredients" layout="full" headerInToolbar>
      <IngredientList />
    </Page>
  );
}
