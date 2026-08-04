import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen, Link2, Plus, Share2 } from "lucide-react";
import { RecipeList } from "~/app/recipes/recipelist";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/recipes/")({
  component: RecipesPage,
  head: () => ({ meta: [{ title: pageTitle("Recipes") }] }),
});

function RecipesPage() {
  return (
    <Page variant="list" title="Recipes" fullWidth>
      <RecipeList
        actions={
          <>
            <Link to="/entities" search={{ tab: "recipes" }}>
              <Button variant="outline">
                <Share2 />
                Graph
              </Button>
            </Link>
            <Link to="/recipes/new" search={{ scrape: true }}>
              <Button variant="outline">
                <Link2 />
                Import from URL
              </Button>
            </Link>
            <Link to="/recipes/import">
              <Button variant="outline">
                <BookOpen />
                Import
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
