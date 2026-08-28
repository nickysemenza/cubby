import { createFileRoute } from "@tanstack/react-router";

import { McpInspector } from "~/app/_components/dev/mcp-inspector";
import { Page } from "~/components/page/Page";
import { pageTitle } from "~/lib/page-title";

export const Route = createFileRoute("/_authenticated/mcp")({
  component: McpInspectorPage,
  head: () => ({ meta: [{ title: pageTitle("MCP tools") }] }),
});

function McpInspectorPage() {
  return (
    <Page variant="list" title="MCP tools">
      <McpInspector />
    </Page>
  );
}
