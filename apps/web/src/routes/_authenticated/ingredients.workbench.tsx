import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { EnrichmentWorkbench } from "~/app/ingredients/enrichment-workbench";
import { Page } from "~/components/page/Page";

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
    <Page variant="list" title="Ingredient Workbench" fullWidth>
      <EnrichmentWorkbench focus={focus} />
    </Page>
  );
}
