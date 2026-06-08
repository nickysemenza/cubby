import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CookbookImport } from "~/app/_components/recipe/cookbook-import";
import { PageWrapper } from "~/components/layout/page-wrapper";

// `?from=<cookbookId>` re-opens that cookbook's stored extraction for selective
// re-import (the "Add from source" path); absent for the normal drag-EPUB flow.
const searchSchema = z.object({ from: z.string().optional() });

export const Route = createFileRoute("/_authenticated/recipes/import-cookbook")(
  {
    component: ImportCookbookPage,
    validateSearch: searchSchema,
    head: () => ({ meta: [{ title: "Import cookbook | cubby" }] }),
  },
);

function ImportCookbookPage() {
  const { from } = Route.useSearch();
  return (
    <PageWrapper>
      <CookbookImport loadCookbookId={from} />
    </PageWrapper>
  );
}
