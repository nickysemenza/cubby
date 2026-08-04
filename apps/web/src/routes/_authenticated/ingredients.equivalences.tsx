import { createFileRoute } from "@tanstack/react-router";
import { EquivalencesReport } from "~/app/ingredients/equivalences-report";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute(
  "/_authenticated/ingredients/equivalences",
)({
  head: () => ({ meta: [{ title: pageTitle("Equivalences") }] }),
  component: IngredientEquivalencesPage,
});

function IngredientEquivalencesPage() {
  return (
    <Page variant="list" title="Recipe-derived equivalences" fullWidth>
      <EquivalencesReport />
    </Page>
  );
}
