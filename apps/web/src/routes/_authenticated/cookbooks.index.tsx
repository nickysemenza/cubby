import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { CookbookList } from "~/app/cookbooks/cookbooklist";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/cookbooks/")({
  component: CookbooksPage,
  head: () => ({ meta: [{ title: pageTitle("Cookbooks") }] }),
});

function CookbooksPage() {
  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Cookbooks"
      actions={
        <Link to="/recipes/import">
          <Button variant="outline">
            <BookOpen />
            Import cookbook
          </Button>
        </Link>
      }
    >
      <CookbookList />
    </Page>
  );
}
