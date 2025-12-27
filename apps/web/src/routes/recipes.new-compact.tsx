import { createFileRoute } from "@tanstack/react-router";
import NewCompactRecipe from "~/app/_components/recipe/NewCompactRecipe";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/recipes/new-compact")({
  component: NewCompactRecipePage,
});

function NewCompactRecipePage() {
  return (
    <PageWrapper>
      <NewCompactRecipe />
    </PageWrapper>
  );
}
