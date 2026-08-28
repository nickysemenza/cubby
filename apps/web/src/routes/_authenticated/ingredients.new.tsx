import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/components/page/Page";
import { EntityEditPage } from "~/entities/editing/entity-edit-page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/ingredients/new")({
  head: () => ({ meta: [{ title: pageTitle("New ingredient") }] }),
  component: NewIngredientPage,
});

function NewIngredientPage() {
  return (
    <Page variant="list" title="New ingredient" compact>
      <EntityEditPage entity="ingredient" />
    </Page>
  );
}
