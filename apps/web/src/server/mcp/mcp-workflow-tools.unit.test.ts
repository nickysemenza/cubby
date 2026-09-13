import { referentialLivenessViolationSchema } from "@cubby/schemas/entity-integrity";
import { problemsCountSchema } from "@cubby/schemas/mcp";
import { getMealPreparationsOut } from "@cubby/schemas/meal";
import { buildNutrition, type NutritionTotals } from "@cubby/schemas/nutrition";
import { productResolveNamesOut } from "@cubby/schemas/product";
import { expenseAnalyticsOut } from "@cubby/schemas/project";
import { recipeCostingExplain } from "@cubby/schemas/recipe-shared";
import { similarEntitiesOut } from "@cubby/schemas/search";
import type { McpToolCallTelemetry } from "@cubby/schemas/telemetry";
import { describe, expect, it, vi } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer } from "./server";

/** The mock generator can't satisfy the coverage refine; build totals by hand. */
const knownTotals: NutritionTotals = {
  cost: {
    status: "complete",
    lower: 1.5,
    upper: null,
    coverage: { covered: 2, total: 2 },
  },
  nutrition: buildNutrition((key) =>
    key === "kcal"
      ? {
          status: "complete",
          lower: 120,
          upper: null,
          coverage: { covered: 2, total: 2 },
        }
      : { status: "pending", reason: "totals_missing" },
  ),
};

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

  it("projects internal diagnostic ids out of problem slices", async () => {
    const diagnostic = mock(referentialLivenessViolationSchema);
    const result = await callMcpTool(
      createMcpServer(),
      "list_problems",
      { type: "referentialLivenessViolations" },
      {
        problems: {
          getByType: async () => ({
            type: "referentialLivenessViolations" as const,
            items: [diagnostic],
            total: 1,
          }),
        },
      },
    );
    const serialized = JSON.stringify(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(serialized).not.toContain(diagnostic.targetId);
    expect(serialized).not.toContain(diagnostic.sourceId);
    expect(serialized).toContain(diagnostic.description);
  });

  it("records success, validation failure, and an unregistered tool without payload telemetry", async () => {
    const identity = {
      userId: "user_1",
      clientId: "oauth-client-1",
      surface: "external_mcp" as const,
    };
    const emit = vi.fn(async (_event: McpToolCallTelemetry) => undefined);
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
    const firstEvent = emit.mock.calls[0]?.[0];
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
    const similarResult = similarEntitiesOut.parse({
      source: { entityType: "product", entityId: "PRD-2222" },
      status: "uncomputed",
      results: [],
    });
    const similar = vi.fn(async () => similarResult);
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
    const readSimilar = vi.fn(async () =>
      similarEntitiesOut.parse({
        source: { entityType: "product", entityId: "PRD-2222" },
        status: "uncomputed",
        results: [],
      }),
    );

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

  it("resolve_products is a pure lookup that forwards trimmed names", async () => {
    const resolveNames = vi.fn(async () => mock(productResolveNamesOut));
    const result = await callMcpTool(
      createMcpServer(),
      "resolve_products",
      { names: ["Lee Kum Kee Premium Soy Sauce, 500 ml", "zzz"] },
      { product: { resolveNames } },
    );

    expect(result.isError).not.toBe(true);
    expect(resolveNames).toHaveBeenCalledWith({
      names: ["Lee Kum Kee Premium Soy Sauce, 500 ml", "zzz"],
    });
    expect(result.structuredContent).toMatchObject({
      results: expect.any(Array),
    });
  });

  it("explain_recipe_costing detail=lines drops both totals blocks and drift", async () => {
    const explain = mock(recipeCostingExplain, {
      overrides: {
        persisted: { totals: knownTotals },
        computed: { totals: knownTotals },
      },
    });
    const explainCosting = vi.fn(async () => explain);
    const server = createMcpServer();

    const full = await callMcpTool(
      server,
      "explain_recipe_costing",
      { id: "RCP-4K7M" },
      { recipe: { explainCosting } },
    );
    const lines = await callMcpTool(
      server,
      "explain_recipe_costing",
      { id: "RCP-4K7M", detail: "lines" },
      { recipe: { explainCosting } },
    );

    expect(full.isError).not.toBe(true);
    expect(lines.isError).not.toBe(true);
    expect(full.structuredContent).toHaveProperty("drift");
    expect(full.structuredContent).toHaveProperty("computed.totals");
    expect(lines.structuredContent).not.toHaveProperty("drift");
    expect(lines.structuredContent).not.toHaveProperty("computed.totals");
    expect(lines.structuredContent).not.toHaveProperty("persisted.totals");
    expect(lines.structuredContent).toMatchObject({
      detail: "lines",
      coverage: {
        cost: explain.computed.totals.cost,
        kcal: explain.computed.totals.nutrition.kcal,
      },
      computed: { diagnostics: explain.computed.diagnostics },
    });
  });

  it("get_meal_preparations nutrition=kcal keeps cost and only the kcal estimate", async () => {
    const view = mock(getMealPreparationsOut, {
      overrides: {
        preparations: [],
        totals: {
          confirmed: { totals: knownTotals },
          projected: { totals: knownTotals },
        },
      },
    });
    const getPreparations = vi.fn(async () => view);
    const server = createMcpServer();

    const kcal = await callMcpTool(
      server,
      "get_meal_preparations",
      { mealId: view.mealId, nutrition: "kcal" },
      { meal: { getPreparations } },
    );
    const none = await callMcpTool(
      server,
      "get_meal_preparations",
      { mealId: view.mealId, nutrition: "none" },
      { meal: { getPreparations } },
    );

    expect(kcal.isError).not.toBe(true);
    expect(none.isError).not.toBe(true);
    expect(getPreparations).toHaveBeenCalledWith({ mealId: view.mealId });
    expect(kcal.structuredContent).toMatchObject({
      totals: {
        confirmed: {
          totals: {
            cost: view.totals.confirmed.totals.cost,
            nutrition: { kcal: view.totals.confirmed.totals.nutrition.kcal },
          },
        },
      },
    });
    expect(
      JSON.stringify(kcal.structuredContent).match(/"protein"/g) ?? [],
    ).toHaveLength(0);
    expect(none.structuredContent).toMatchObject({
      totals: {
        projected: {
          totals: { cost: view.totals.projected.totals.cost, nutrition: {} },
        },
      },
    });
    expect(JSON.stringify(none.structuredContent)).not.toContain('"kcal"');
  });
});
