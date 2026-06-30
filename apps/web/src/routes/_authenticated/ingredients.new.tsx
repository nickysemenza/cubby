import { createFileRoute } from "@tanstack/react-router";
import { NewEntityPage } from "~/components/entity/new-entity-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/ingredients/new")({
  component: NewIngredientPage,
});

function NewIngredientPage() {
  return (
    <Page variant="list" title="New ingredient" compact>
      <NewEntityPage entity="ingredient" />
    </Page>
  );
}
