import { createFileRoute } from "@tanstack/react-router";
import { DocsPage as DocsContent } from "~/app/docs/docs-page";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
});

function DocsPage() {
  return (
    <Page variant="list" title="Documentation" compact>
      <DocsContent />
    </Page>
  );
}
