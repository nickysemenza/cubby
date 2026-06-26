import { createFileRoute } from "@tanstack/react-router";
import { NotionImport } from "~/app/_components/recipe/notion-import";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/recipes/import-notion")({
  component: ImportNotionPage,
  head: () => ({ meta: [{ title: "Import from Notion | cubby" }] }),
});

function ImportNotionPage() {
  return (
    <Page
      variant="list"
      title="Import from Notion"
      eyebrow="Recipes"
      compact
      decoration="none"
    >
      <NotionImport />
    </Page>
  );
}
