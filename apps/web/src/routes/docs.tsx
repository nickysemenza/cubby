import { createFileRoute } from "@tanstack/react-router";
import { DocsPage as DocsContent } from "~/app/docs/docs-page";
import { authMiddleware } from "~/lib/protected-route";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
  server: {
    middleware: [authMiddleware],
  },
});

function DocsPage() {
  return <DocsContent />;
}
