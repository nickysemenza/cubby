import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { Page } from "~/entity/page/page";
import { CookbookImport } from "~/features/recipe/cookbook-import";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  // `?from=<cookbookId>` re-opens that cookbook's stored extraction for
  // selective re-import (the "Add from source" path); absent for the normal
  // drag-EPUB flow.
  from: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/recipes/import")({
  validateSearch: searchSchema,
  component: ImportPage,
  head: () => ({ meta: [{ title: pageTitle("Import recipes") }] }),
});

function ImportPage() {
  const { from } = Route.useSearch();

  return (
    <Page variant="list" title="Import recipes" eyebrow="Recipes">
      <CookbookImport loadCookbookId={from} />
    </Page>
  );
}
