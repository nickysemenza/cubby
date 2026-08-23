import type { McpUsageDashboardOut } from "@cubby/schemas/telemetry";
import { describe, expect, it } from "vitest";
import { filterAndSortMcpTools } from "./mcp-usage-dashboard";

type ToolRow = McpUsageDashboardOut["tools"][number];

function tool(
  toolName: string,
  status: ToolRow["status"],
  periodCalls: number,
): ToolRow {
  return {
    toolName,
    title: null,
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    status,
    registered: status !== "retired",
    lifetimeCalls: periodCalls,
    periodCalls,
    periodSuccesses: periodCalls,
    periodErrors: 0,
    firstUsedAt: null,
    lastUsedAt: null,
    lastRelease: null,
    daily: [],
    users: [],
    clients: [],
  };
}

describe("MCP pruning worklist derivation", () => {
  it("combines status/search filters and ranked sorting", () => {
    const result = filterAndSortMcpTools(
      [
        tool("search_products", "active", 12),
        tool("search_recipes", "inactive", 0),
        tool("get_product", "active", 4),
      ],
      { search: "search", status: "active" },
      { key: "periodCalls", descending: true },
    );

    expect(result.map((row) => row.toolName)).toEqual(["search_products"]);
  });
});
