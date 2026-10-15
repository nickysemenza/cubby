import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import { McpInspector } from "~/features/developer/mcp-inspector";
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
