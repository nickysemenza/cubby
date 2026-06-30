import { createFileRoute } from "@tanstack/react-router";
import { IngredientList } from "~/app/ingredients/ingredientlist";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/ingredients/")({
  component: IngredientsPage,
});

function IngredientsPage() {
  return (
    <Page variant="list" title="Ingredients" fullWidth>
      <IngredientList />
    </Page>
  );
}
