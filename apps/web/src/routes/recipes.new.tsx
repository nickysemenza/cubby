import { createFileRoute } from "@tanstack/react-router";
import NewRecipe from "~/app/_components/recipe/new-recipe";
import { PageWrapper } from "~/components/layout/page-wrapper";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/recipes/new")({
  component: NewRecipePage,
  server: {
    middleware: [authMiddleware],
  },
});

function NewRecipePage() {
  return (
    <PageWrapper>
      <NewRecipe />
    </PageWrapper>
  );
}
