import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { EnrichmentWorkbench } from "~/app/ingredients/enrichment-workbench";
import { EntityLayout } from "~/components/layouts/entity-layout";

// `focus` is an ingredient id to scroll to + auto-expand on load — set by the
// Problems page's "Fix in workbench" links so a click lands on the exact row.
const workbenchSearch = z.object({ focus: z.string().optional() });

export const Route = createFileRoute("/_authenticated/ingredients/workbench")({
  component: IngredientWorkbenchPage,
  validateSearch: workbenchSearch,
});

function IngredientWorkbenchPage() {
  const { focus } = Route.useSearch();
  return (
    <EntityLayout title="Ingredient Workbench" fullWidth>
      <EnrichmentWorkbench focus={focus} />
    </EntityLayout>
  );
}
