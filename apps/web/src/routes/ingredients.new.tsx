import { createFileRoute } from "@tanstack/react-router";
import { NewIngredient } from "~/app/_components/ingredients/new-ingredient";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/ingredients/new")({
  component: NewIngredientPage,
});

function NewIngredientPage() {
  return (
    <PageWrapper>
      <NewIngredient />
    </PageWrapper>
  );
}
