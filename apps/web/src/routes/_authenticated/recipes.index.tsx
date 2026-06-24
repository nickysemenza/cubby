import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen, NotebookPen, Plus, Share2 } from "lucide-react";
import { RecipeList } from "~/app/recipes/recipelist";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/_authenticated/recipes/")({
  component: RecipesPage,
  head: () => ({ meta: [{ title: "Recipes | cubby" }] }),
});

function RecipesPage() {
  return (
    <Page variant="list" title="Recipes" entity="recipe" fullWidth>
      <RecipeList
        actions={
          <>
            <Link to="/recipes/graph">
              <Button variant="outline">
                <Share2 />
                Graph
              </Button>
            </Link>
            <Link to="/recipes/import-cookbook">
              <Button variant="outline">
                <BookOpen />
                Import cookbook
              </Button>
            </Link>
            <Link to="/recipes/import-notion">
              <Button variant="outline">
                <NotebookPen />
                Import from Notion
              </Button>
            </Link>
            <Link to="/recipes/new">
              <Button>
                <Plus />
                New
              </Button>
            </Link>
          </>
        }
      />
    </Page>
  );
}
