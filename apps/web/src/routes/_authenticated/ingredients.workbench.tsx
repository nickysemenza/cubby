import { createFileRoute } from "@tanstack/react-router";
import { EnrichmentWorkbench } from "~/app/ingredients/enrichment-workbench";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/ingredients/workbench")({
  component: IngredientWorkbenchPage,
});

function IngredientWorkbenchPage() {
  return (
    <EntityLayout title="Ingredient Workbench" fullWidth>
      <EnrichmentWorkbench />
    </EntityLayout>
  );
}
