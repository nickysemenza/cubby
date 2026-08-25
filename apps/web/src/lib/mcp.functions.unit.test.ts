import { describe, expect, it } from "vitest";
import {
  mcpCatalogQueryOptions,
  mcpUsageActivityInfiniteQueryOptions,
  mcpUsageDashboardQueryOptions,
} from "./mcp.functions";

describe("MCP Start query contracts", () => {
  it("keeps stable domain-local keys", () => {
    expect(mcpCatalogQueryOptions().queryKey).toEqual([["mcp", "listTools"]]);
    expect(mcpUsageDashboardQueryOptions({ window: 90 }).queryKey).toEqual([
      ["mcp", "usageDashboard"],
      { input: { window: 90 } },
    ]);
    expect(
      mcpUsageActivityInfiniteQueryOptions({
        window: 30,
        toolName: "entity",
        limit: 25,
      }).queryKey,
    ).toEqual([
      ["mcp", "usageActivity"],
      {
        input: { window: 30, toolName: "entity", limit: 25 },
        type: "infinite",
      },
    ]);
  });

  it("marks all calls as observed Start operations", () => {
    for (const options of [
      mcpCatalogQueryOptions(),
      mcpUsageDashboardQueryOptions({ window: "lifetime" }),
      mcpUsageActivityInfiniteQueryOptions({ window: 7, limit: 25 }),
    ]) {
      expect(options.meta).toMatchObject({
        transport: "start",
        observedByTransport: true,
      });
    }
  });
});
