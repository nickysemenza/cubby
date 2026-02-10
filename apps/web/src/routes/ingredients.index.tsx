import { createFileRoute } from "@tanstack/react-router";
import { IngredientList } from "~/app/ingredients/ingredientlist";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/ingredients/")({
  component: IngredientsPage,
});

function IngredientsPage() {
  return (
    <EntityLayout title="Ingredients" fullWidth>
      <IngredientList />
    </EntityLayout>
  );
}
