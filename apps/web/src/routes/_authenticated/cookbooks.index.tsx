import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen } from "lucide-react";
import { CookbookList } from "~/app/cookbooks/cookbooklist";
import { EntityLayout } from "~/components/layouts/entity-layout";
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
    <EntityLayout
      title="Cookbooks"
      entity="cookbook"
      actions={
        <Link to="/recipes/import-cookbook">
          <Button variant="outline">
            <BookOpen />
            Import cookbook
          </Button>
        </Link>
      }
    >
      <CookbookList />
    </EntityLayout>
  );
}
