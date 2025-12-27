import { createFileRoute } from "@tanstack/react-router";
import { DocsPage as DocsContent } from "~/app/docs/docs-page";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
});

function DocsPage() {
  return <DocsContent />;
}
