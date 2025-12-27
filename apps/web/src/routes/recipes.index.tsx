import { createFileRoute, Link } from "@tanstack/react-router";
import { RecipeList } from "~/app/recipes/recipelist";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/recipes/")({
  component: RecipesPage,
  head: () => ({ meta: [{ title: "Recipes | RecipeHub" }] }),
});

function RecipesPage() {
  return (
    <EntityLayout
      title="Recipes"
      actions={
        <Link to="/recipes/new">
          <Button>Create New Recipe</Button>
        </Link>
      }
    >
      <RecipeList />
    </EntityLayout>
  );
}
