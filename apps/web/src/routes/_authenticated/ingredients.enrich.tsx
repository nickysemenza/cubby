import { createFileRoute } from "@tanstack/react-router";
import { EnrichmentQueue } from "~/app/ingredients/enrich-queue";
import { EntityLayout } from "~/components/layouts/entity-layout";

export const Route = createFileRoute("/_authenticated/ingredients/enrich")({
  component: EnrichIngredientsPage,
});

function EnrichIngredientsPage() {
  return (
    <EntityLayout title="Enrich Ingredients" fullWidth>
      <EnrichmentQueue />
    </EntityLayout>
  );
}
