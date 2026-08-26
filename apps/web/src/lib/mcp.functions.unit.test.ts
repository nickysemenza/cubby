import { describe, expect, it } from "vitest";
import { mcp } from "./mcp.functions";

const activityOptions = (window: 7 | 30) =>
  mcp.usageActivity.infiniteQueryOptions<string | null>(
    { window, toolName: window === 30 ? "entity" : undefined, limit: 25 },
    {
      initialPageParam: null,
      page: (input, cursor) => ({
        ...input,
        ...(cursor === null ? {} : { cursor }),
      }),
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    },
  );

describe("MCP Start query contracts", () => {
  it("keeps stable domain-local keys", () => {
    expect(mcp.listTools.queryOptions(null).queryKey).toEqual([
      "operation",
      "mcp.listTools",
      { input: null },
    ]);
    expect(mcp.usageDashboard.queryOptions({ window: 90 }).queryKey).toEqual([
      "operation",
      "mcp.usageDashboard",
      { input: { window: 90 } },
    ]);
    expect(activityOptions(30).queryKey).toEqual([
      "operation",
      "mcp.usageActivity",
      "infinite",
      {
        input: { window: 30, toolName: "entity", limit: 25 },
      },
    ]);
  });

  it("marks all calls as observed Start operations", () => {
    for (const options of [
      mcp.listTools.queryOptions(null),
      mcp.usageDashboard.queryOptions({ window: "lifetime" }),
      activityOptions(7),
    ]) {
      expect(options.meta).toMatchObject({
        transport: "start",
        observedByTransport: true,
      });
    }
  });
});
