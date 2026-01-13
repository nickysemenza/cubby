import { createFileRoute } from "@tanstack/react-router";
import { IngredientList } from "~/app/ingredients/ingredientlist";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/ingredients/")({
  component: IngredientsPage,
  server: {
    middleware: [authMiddleware],
  },
});

function IngredientsPage() {
  return (
    <EntityLayout title="Ingredients">
      <IngredientList />
    </EntityLayout>
  );
}
