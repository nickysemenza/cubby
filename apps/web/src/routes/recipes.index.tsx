import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { RecipeList } from "~/app/recipes/recipelist";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/recipes/")({
  component: RecipesPage,
  head: () => ({ meta: [{ title: "Recipes | RecipeHub" }] }),
  server: {
    middleware: [authMiddleware],
  },
});

function RecipesPage() {
  return (
    <EntityLayout title="Recipes">
      <RecipeList
        actions={
          <Link to="/recipes/new">
            <Button size="sm" className="h-7 gap-1 text-xs">
              <Plus className="h-3.5 w-3.5" />
              New
            </Button>
          </Link>
        }
      />
    </EntityLayout>
  );
}
