import { createFileRoute } from "@tanstack/react-router";
import { DocsPage as DocsContent } from "~/app/docs/docs-page";
import { PageWrapper } from "~/components/layout/page-wrapper";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
});

function DocsPage() {
  return (
    <PageWrapper>
      <DocsContent />
    </PageWrapper>
  );
}
