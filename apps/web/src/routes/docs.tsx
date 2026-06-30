import { createFileRoute } from "@tanstack/react-router";
import { DocsLayout } from "~/app/docs/docs-layout";
import { Page } from "~/components/page/Page";

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
