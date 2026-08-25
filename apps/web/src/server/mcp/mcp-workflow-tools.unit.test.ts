import { problemsCountSchema } from "@cubby/schemas/mcp";
import { expenseAnalyticsOut } from "@cubby/schemas/project";
import { describe, expect, it, vi } from "vitest";
import { mock } from "~/lib/test/mock-schema";
import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer } from "./server";

describe("MCP workflow tools", () => {
  it("routes counts-only problem triage to the cheap caller port", async () => {
    const getCounts = vi.fn(async () => mock(problemsCountSchema));
    const result = await callMcpTool(
      createMcpServer(),
      "list_problems",
      { countsOnly: true },
      { problems: { getCounts, getByType: vi.fn() } },
    );

    expect(result.isError).not.toBe(true);
    expect(getCounts).toHaveBeenCalledOnce();
  });

  it("records success, validation failure, and an unregistered tool without payload telemetry", async () => {
    const identity = {
      userId: "user_1",
      clientId: "oauth-client-1",
      surface: "external_mcp" as const,
    };
    const emit = vi.fn(async (_event: unknown) => undefined);
    await callMcpTool(
      createMcpServer(),
      "list_problems",
      { countsOnly: true },
      { problems: { getCounts: async () => mock(problemsCountSchema) } },
      { telemetry: { identity, emit } },
    );
    await callMcpTool(
      createMcpServer(),
      "get_expense_analytics",
      { unknownFilter: "not-a-filter" },
      { expense: { analytics: vi.fn() } },
      { telemetry: { identity, emit } },
    );
    await callMcpTool(
      createMcpServer(),
      "retired_tool",
      {},
      {},
      { telemetry: { identity, emit } },
    ).catch(() => undefined);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identity,
        toolName: "list_problems",
        outcome: "success",
        registeredAtCall: true,
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "get_expense_analytics",
        outcome: "error",
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "retired_tool",
        outcome: "error",
        registeredAtCall: false,
      }),
    );
    const firstEvent = emit.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(Object.keys(firstEvent ?? {})).not.toEqual(
      expect.arrayContaining(["arguments", "output", "errorText"]),
    );
  });

  it("rejects unknown filters but forwards valid workflow filters", async () => {
    const analytics = vi.fn(async () => mock(expenseAnalyticsOut));
    const unknown = await callMcpTool(
      createMcpServer(),
      "get_expense_analytics",
      { costMinn: 500 },
      { expense: { analytics } },
    );
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain("costMinn");
    expect(analytics).not.toHaveBeenCalled();

    const valid = await callMcpTool(
      createMcpServer(),
      "get_expense_analytics",
      { costMin: 500 },
      { expense: { analytics } },
    );
    expect(valid.isError).not.toBe(true);
    expect(analytics).toHaveBeenCalledWith({ costMin: 500 });
  });

  it("enforces the semantic pair allowlist before it reaches the caller port", async () => {
    const similar = vi.fn(async () => ({
      source: { entityType: "product", entityId: "PRD-2222" },
      status: "uncomputed" as const,
      results: [],
    }));
    const allowed = await callMcpTool(
      createMcpServer(),
      "find_similar_entities",
      { pair: "product_to_product", sourceId: "PRD-2222", limit: 3 },
      { search: { similar } },
    );
    expect(allowed.isError).not.toBe(true);
    expect(similar).toHaveBeenCalledWith({
      pair: "product_to_product",
      sourceId: "PRD-2222",
      limit: 3,
    });

    const rejected = await callMcpTool(
      createMcpServer(),
      "find_similar_entities",
      { pair: "expense_to_product", sourceId: "PRD-2222" },
      { search: { similar } },
    );
    expect(rejected.isError).toBe(true);
    expect(similar).toHaveBeenCalledTimes(1);
  });

  it("uses the bounded-stale caller only for MCP search tools", async () => {
    const strongSimilar = vi.fn();
    const readSimilar = vi.fn(async () => ({
      source: { entityType: "product", entityId: "PRD-2222" },
      status: "uncomputed" as const,
      results: [],
    }));

    const result = await callMcpTool(
      createMcpServer(),
      "find_similar_entities",
      { pair: "product_to_product", sourceId: "PRD-2222", limit: 3 },
      { search: { similar: strongSimilar } },
      { readCaller: { search: { similar: readSimilar } } },
    );

    expect(result.isError).not.toBe(true);
    expect(readSimilar).toHaveBeenCalledOnce();
    expect(strongSimilar).not.toHaveBeenCalled();
  });
});
