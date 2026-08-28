import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { EnrichmentWorkbench } from "~/app/ingredients/enrichment-workbench";
import { equivalenceDraftFromSearch } from "~/app/ingredients/equivalence-workbench-link";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

// `focus` is an ingredient id to scroll to + auto-expand on load — set by the
// Problems page's "Fix in workbench" links so a click lands on the exact row.
// `recipe` scopes the worklist to one recipe's sub-recipe tree — set by the
// recipe detail "N block totals" popover's "Open all in workbench" link.
const workbenchSearch = z.object({
  focus: z.string().optional(),
  recipe: z.string().optional(),
  equivalenceFromUnit: z.string().optional(),
  equivalenceToUnit: z.string().optional(),
  equivalenceToValue: z.coerce.number().positive().optional(),
});

export const Route = createFileRoute("/_authenticated/ingredients/workbench")({
  component: IngredientWorkbenchPage,
  validateSearch: workbenchSearch,
  head: () => ({ meta: [{ title: pageTitle("Ingredient workbench") }] }),
});

function IngredientWorkbenchPage() {
  const search = Route.useSearch();
  return (
    <Page variant="list" title="Ingredient Workbench" layout="full">
      <EnrichmentWorkbench
        focus={search.focus}
        recipeId={search.recipe}
        initialConversion={equivalenceDraftFromSearch(search)}
      />
    </Page>
  );
}
