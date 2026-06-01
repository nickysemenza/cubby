import { createFileRoute } from "@tanstack/react-router";
import { CookbookImport } from "~/app/_components/recipe/cookbook-import";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/recipes/import-cookbook")(
  {
    component: ImportCookbookPage,
    head: () => ({ meta: [{ title: "Import cookbook | cubby" }] }),
  },
);

function ImportCookbookPage() {
  return (
    <PageWrapper>
      <CookbookImport />
    </PageWrapper>
  );
}
