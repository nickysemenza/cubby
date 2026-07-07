import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { CookbookList } from "~/app/cookbooks/cookbooklist";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/_authenticated/cookbooks/")({
  // Client-only: CookbookList suspends on a protected query that needs the auth
  // cookie, which isn't present during SSR (matches the recipe detail route).
  ssr: false,
  component: CookbooksPage,
  head: () => ({ meta: [{ title: "Cookbooks | cubby" }] }),
});

function CookbooksPage() {
  return (
    <Page
      variant="list"
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
