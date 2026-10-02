import { createFileRoute } from "@tanstack/react-router";

import { EquivalencesReport } from "~/app/ingredients/equivalences-report";
import { pageTitle } from "~/lib/page-title";
import { Page } from "~/ui/page/Page";

export const Route = createFileRoute(
  "/_authenticated/ingredients/equivalences",
)({
  head: () => ({ meta: [{ title: pageTitle("Equivalences") }] }),
  component: IngredientEquivalencesPage,
});

function IngredientEquivalencesPage() {
  return (
    <Page variant="list" title="Recipe-derived equivalences" layout="full">
      <EquivalencesReport />
    </Page>
  );
}
