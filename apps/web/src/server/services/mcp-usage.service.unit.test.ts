import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import {
  getMcpUsageDashboard,
  type McpUsageDashboardPort,
} from "./mcp-usage.service";

const unusedDatabase = new Database(() => {
  throw new Error("The injected MCP usage port must not access the database");
});

const port: McpUsageDashboardPort = {
  listCatalog: async () => ({
    tools: ["active_tool", "inactive_tool", "never_tool"].map((name) => ({
      name,
      description: `${name} description`,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    })),
  }),
  loadAggregate: async () => ({
    observationStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    lifetimeTools: [
      {
        toolName: "active_tool",
        calls: 10,
        firstUsedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastUsedAt: new Date("2026-08-01T00:00:00.000Z"),
        lastRelease: "current",
      },
      {
        toolName: "inactive_tool",
        calls: 3,
        firstUsedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastUsedAt: new Date("2026-02-01T00:00:00.000Z"),
        lastRelease: "old",
      },
      {
        toolName: "retired_tool",
        calls: 2,
        firstUsedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastUsedAt: new Date("2026-02-01T00:00:00.000Z"),
        lastRelease: "old",
      },
    ],
    periodTools: [
      { toolName: "active_tool", calls: 4, successes: 3, errors: 1 },
    ],
    daily: [
      {
        toolName: "active_tool",
        day: "2026-08-01",
        success: 3,
        error: 1,
        total: 4,
      },
    ],
    toolUsers: [],
    toolClients: [],
    userBreakdown: [],
    clientBreakdown: [],
    surfaceBreakdown: [],
    entityBreakdown: [
      { key: "product", label: "product", count: 3 },
      { key: "unknown", label: "Unattributed", count: 1 },
    ],
  }),
};

describe("getMcpUsageDashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00.000Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("classifies active, inactive, never, and retired tools", async () => {
    const result = await getMcpUsageDashboard(unusedDatabase, 90, port);
    expect(
      Object.fromEntries(
        result.tools.map((tool) => [tool.toolName, tool.status]),
      ),
    ).toEqual({
      active_tool: "active",
      inactive_tool: "inactive",
      never_tool: "never",
      retired_tool: "retired",
    });
    expect(result.totals).toMatchObject({
      registered: 3,
      active: 1,
      inactive: 1,
      never: 1,
      retired: 1,
      calls: 4,
      errors: 1,
    });
    expect(result.observationComplete).toBe(true);
  });
});
