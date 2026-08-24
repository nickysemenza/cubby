import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { listPage } from "~/app/_components/routing/entity-routes";
import { CookbookList } from "~/app/cookbooks/cookbooklist";
import { Button } from "~/components/ui/button";
import { pageTitle } from "~/lib/page-title";

// Bound to a const, not inlined into the options object: the router plugin's
// splitter re-parses an inlined call expression with a JSX-less babel config,
// so only the identifier path survives a page body that renders JSX.
const CookbooksPage = listPage({
  title: "Cookbooks",
  list: CookbookList,
  // Factory-default `full` layout: the old card grid wanted `contained`, but
  // this is a standard ListWorkbench table now and matches the other entity
  // lists' chrome.
  actions: () => (
    <Link to="/recipes/import">
      <Button variant="outline">
        <BookOpen />
        Import cookbook
      </Button>
    </Link>
  ),
});

export const Route = createFileRoute("/_authenticated/cookbooks/")({
  head: () => ({ meta: [{ title: pageTitle("Cookbooks") }] }),
  component: CookbooksPage,
});
