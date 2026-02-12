import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/ingredients/new")({
  component: NewIngredientPage,
});

function NewIngredientPage() {
  return (
    <PageWrapper>
      <NewEntityPage entity="ingredient" />
    </PageWrapper>
  );
}
