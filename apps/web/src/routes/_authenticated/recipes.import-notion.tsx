import { createFileRoute } from "@tanstack/react-router";
import { NotionImport } from "~/app/_components/recipe/notion-import";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/_authenticated/recipes/import-notion")({
  component: ImportNotionPage,
  head: () => ({ meta: [{ title: "Import from Notion | cubby" }] }),
});

function ImportNotionPage() {
  return (
    <PageWrapper>
      <NotionImport />
    </PageWrapper>
  );
}
