import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import { DocsLayout } from "~/features/docs/docs-layout";

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
