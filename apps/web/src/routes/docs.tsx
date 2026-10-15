import { createFileRoute } from "@tanstack/react-router";

import { DocsLayout } from "~/features/docs/docs-layout";
import { Page } from "~/ui/layout/page";

export const Route = createFileRoute("/docs")({
  component: DocsLayoutRoute,
});

function DocsLayoutRoute() {
  return (
    <Page variant="list" title="Documentation" compact>
      <DocsLayout />
    </Page>
  );
}
