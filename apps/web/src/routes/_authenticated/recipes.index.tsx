import {
  createFileRoute,
  Link,
  stripSearchParams,
} from "@tanstack/react-router";
import { BookOpen, Link2, Plus, Share2 } from "lucide-react";
import { listPage } from "~/app/_components/routing/entity-routes";
import { RecipeList } from "~/app/recipes/recipelist";
import { Button } from "~/components/ui/button";
import { ensureEntityListSsr } from "~/entities/entity-list-ssr";
import { recipeListSearchSchema } from "~/entities/list-search";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const RecipesPage = listPage({
  title: "Recipes",
  list: RecipeList,
  actions: () => (
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
  ),
});

export const Route = createFileRoute("/_authenticated/recipes/")({
  validateSearch: recipeListSearchSchema,
  search: { middlewares: [stripSearchParams({})] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps, abortController }) =>
    ensureEntityListSsr({
      queryClient: context.queryClient,
      entity: "recipe",
      search: deps,
      signal: abortController.signal,
    }),
  head: () => ({ meta: [{ title: pageTitle("Recipes") }] }),
  component: RecipesPage,
});
