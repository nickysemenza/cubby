import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen, NotebookPen, Plus } from "lucide-react";
import { RecipeList } from "~/app/recipes/recipelist";
import { EntityLayout } from "~/components/layouts/entity-layout";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/_authenticated/recipes/")({
  component: RecipesPage,
  head: () => ({ meta: [{ title: "Recipes | cubby" }] }),
});

function RecipesPage() {
  return (
    <EntityLayout title="Recipes" entity="recipe" fullWidth>
      <RecipeList
        actions={
          <>
            <Link to="/recipes/import-cookbook">
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
                <BookOpen className="h-3.5 w-3.5" />
                Import cookbook
              </Button>
            </Link>
            <Link to="/recipes/import-notion">
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs">
                <NotebookPen className="h-3.5 w-3.5" />
                Import from Notion
              </Button>
            </Link>
            <Link to="/recipes/new">
              <Button size="sm" className="h-7 gap-1 text-xs">
                <Plus className="h-3.5 w-3.5" />
                New
              </Button>
            </Link>
          </>
        }
      />
    </EntityLayout>
  );
}
