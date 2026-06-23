import { createFileRoute } from "@tanstack/react-router";
import { EquivalencesReport } from "~/app/ingredients/equivalences-report";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute(
  "/_authenticated/ingredients/equivalences",
)({
  component: IngredientEquivalencesPage,
});

function IngredientEquivalencesPage() {
  return (
    <EntityLayout title="Recipe-derived equivalences" fullWidth>
      <EquivalencesReport />
    </EntityLayout>
  );
}
