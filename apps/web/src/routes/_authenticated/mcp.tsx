import { createFileRoute } from "@tanstack/react-router";
import { McpInspector } from "~/app/_components/dev/mcp-inspector";
import { Page } from "~/components/page/Page";

export const Route = createFileRoute("/_authenticated/mcp")({
  component: McpInspectorPage,
  head: () => ({ meta: [{ title: "MCP tools | cubby" }] }),
});

function McpInspectorPage() {
  return (
    <Page variant="list" title="MCP tools">
      <McpInspector />
    </Page>
  );
}
