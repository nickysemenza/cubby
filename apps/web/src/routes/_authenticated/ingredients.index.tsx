import { createFileRoute } from "@tanstack/react-router";
import { IngredientList } from "~/app/ingredients/ingredientlist";
import { Page } from "~/components/page/Page";
import { listHead } from "~/entities/filter-manifest";

export const Route = createFileRoute("/_authenticated/ingredients/")({
  head: listHead("Ingredients", "ingredient"),
  component: IngredientsPage,
});

function IngredientsPage() {
  return (
    <Page variant="list" title="Ingredients" fullWidth>
      <IngredientList />
    </Page>
  );
}
