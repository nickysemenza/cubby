import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { RecipeList } from "~/app/recipes/recipelist";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/_authenticated/recipes/")({
  component: RecipesPage,
  head: () => ({ meta: [{ title: "Recipes | cubby" }] }),
});

function RecipesPage() {
  return (
    <EntityLayout title="Recipes" fullWidth>
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
