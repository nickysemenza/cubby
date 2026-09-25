import { referentialLivenessViolationSchema } from "@cubby/schemas/entity-integrity";
import { mealRecipeId as mealRecipeIdSchema } from "@cubby/schemas/identifiers";
import {
  getMealPreparationsOut,
  mealNutritionOut,
  mealOut,
  nutritionMeal,
} from "@cubby/schemas/meal";
import {
  buildNutrition,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import {
  recipeCostingExplain,
  rowDiagnostic,
} from "@cubby/schemas/recipe-shared";
import type { McpToolCallTelemetry } from "@cubby/schemas/telemetry";
import { testShortcode } from "@cubby/schemas/testing";
import { SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, it, vi } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer, MCP_SERVER_INSTRUCTIONS } from "./server";
import {
  addedMealRecipe,
  dailyIntake,
  mealPreparations,
} from "./tools/meal.tools";
import { pageProblemTypeSlice } from "./tools/problems.tools";
import {
  buildRecipeNutrition,
  costingExplanation,
  effectiveRecipeServings,
} from "./tools/recipe.tools";
import { toolCallResultTraceAttributes } from "./tools/tool-call-telemetry";

/** The mock generator can't satisfy the coverage refine; build totals by hand. */
const knownTotals: NutritionTotals = withMacros({
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
});

describe("MCP workflow tools", () => {
  it("generates shortcode and workflow guidance from current source names", () => {
    for (const [entity, prefix] of Object.entries(SHORTCODE_PREFIX)) {
      expect(MCP_SERVER_INSTRUCTIONS).toContain(`- ${prefix} ${entity}`);
    }
    expect(MCP_SERVER_INSTRUCTIONS).toContain("add_recipe_to_meal");
    expect(MCP_SERVER_INSTRUCTIONS).not.toContain("add_meal_recipe");
    expect(MCP_SERVER_INSTRUCTIONS).not.toContain("attach_file,");
  });

  it("scales recipe nutrition and reports compact unmapped coverage", () => {
    const explain = mock(recipeCostingExplain, {
      overrides: {
        computed: {
          totals: knownTotals,
          diagnostics: [
            mock(rowDiagnostic, {
              overrides: {
                id: "line-covered",
                name: "Covered line",
                missing: { price: false, weight: false, nutrients: false },
              },
            }),
            mock(rowDiagnostic, {
              overrides: {
                id: "line-unmapped",
                name: "Unmapped line",
                missing: { price: false, weight: true, nutrients: true },
              },
            }),
          ],
        },
      },
    });

    const result = buildRecipeNutrition({
      recipe: { id: "RCP-4K7M", name: "Test recipe" },
      recipeServings: 4,
      requestedServings: 2,
      explain,
    });

    expect(result.nutrition.kcal).toMatchObject({ lower: 60 });
    expect(result.coverage).toEqual({
      totalLines: 2,
      mappedLines: 1,
      unmappedLines: [
        {
          id: "line-unmapped",
          name: "Unmapped line",
          reasons: ["weight", "nutrients"],
        },
      ],
    });
    expect(effectiveRecipeServings({ servings: null, yield: null })).toBeNull();
    expect(
      effectiveRecipeServings({ yield: { value: 1, unit: "loaf" } }),
    ).toBeNull();
    expect(
      effectiveRecipeServings({ yield: { value: 8, unit: "servings" } }),
    ).toBe(8);
  });

  it("add_recipe_to_meal defaults to compact coverage and opts into nutrition", () => {
    const meal = mock(mealOut, {
      overrides: { name: "Dinner", totals: knownTotals, recipes: [] },
    });
    const mealRecipeId = mealRecipeIdSchema.parse(
      "00000000-0000-4000-8000-000000000001",
    );

    expect(addedMealRecipe({ meal, mealRecipeId }, "none")).toEqual({
      id: meal.id,
      mealRecipeId,
      name: "Dinner",
      coverage: { cost: 1.5, kcal: 120 },
      nutrition: undefined,
    });
    expect(addedMealRecipe({ meal, mealRecipeId }, "macros")).toMatchObject({
      coverage: { cost: 1.5, kcal: 120 },
      nutrition: { kcal: 120, protein: "pending" },
    });
  });

  it("reads compact daily macros for one eater and only includes foods on request", () => {
    const meal = mock(nutritionMeal);
    const view = mealNutritionOut.parse({
      meals: [meal],
      people: [
        {
          eater: {
            id: testShortcode("ledgerParty", "intake-eater"),
            name: "Example eater",
          },
          totals: knownTotals,
          meals: [{ meal, totals: knownTotals }],
          foods: [
            {
              meal,
              totals: knownTotals,
              name: "Example snack",
              grams: null,
              sourceKind: "manual",
              amount: null,
              weight: { status: "unavailable", reason: "no_data" },
              batchShare: { status: "unavailable", reason: "no_data" },
              id: "00000000-0000-4000-8000-000000000001",
              nutrients: { kcal: 120 },
            },
          ],
        },
      ],
    });
    const person = view.people[0];
    const food = person?.foods[0];
    if (!person || !food) throw new Error("Expected nutrition fixture");
    person.totals = {
      ...knownTotals,
      nutrition: buildNutrition((key) => {
        if (key === "kcal") return knownTotals.nutrition.kcal;
        if (key === "fat")
          return {
            status: "complete",
            lower: 0,
            upper: null,
            coverage: { covered: 1, total: 1 },
          };
        if (key === "protein")
          return {
            status: "partial",
            lower: 12,
            upper: null,
            coverage: { covered: 1, total: 2 },
          };
        if (key === "fiber")
          return { status: "unavailable", reason: "no_data" };
        return { status: "pending", reason: "totals_missing" };
      }),
    };
    person.meals = [{ meal, totals: person.totals }];
    person.foods = [{ ...food, meal, totals: person.totals }];
    const params = { date: "2000-01-01", partyId: person.eater.id };
    const compact = dailyIntake(view, {
      ...params,
      nutrition: "macros",
      includeFoods: false,
    });
    const macros = {
      kcal: 120,
      protein: { lower: 12, upper: null, partial: true },
      carbs: "pending",
      fat: 0,
      fiber: null,
    };
    expect(compact).toEqual({
      ...params,
      status: "logged",
      nutrition: macros,
      meals: [
        {
          mealId: meal.id,
          name: meal.name,
          nutrition: macros,
          foods: undefined,
        },
      ],
    });
    const full = dailyIntake(view, {
      ...params,
      date: "2099-01-01",
      nutrition: "full",
      includeFoods: true,
    });
    expect(full).toMatchObject({
      status: "planned",
      meals: [
        {
          foods: [
            {
              name: food.name,
              grams: food.grams,
              sourceKind: food.sourceKind,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(compact).length).toBeLessThan(
      JSON.stringify(full).length,
    );
  });

  it("keeps a day with no assigned intake unavailable rather than inventing zero", () => {
    const partyId = testShortcode("ledgerParty", "empty-intake");
    expect(
      dailyIntake(
        { meals: [], people: [] },
        {
          date: "2000-01-01",
          partyId,
          nutrition: "macros",
          includeFoods: false,
        },
      ),
    ).toEqual({
      date: "2000-01-01",
      partyId,
      status: "logged",
      nutrition: null,
      meals: [],
    });
  });

  it("pages an explicit problem type report", () => {
    const slice = {
      type: "orphanedProducts" as const,
      items: [{ id: "synthetic-1" }, { id: "synthetic-2" }],
      total: 2,
    };
    expect(pageProblemTypeSlice(slice, { pageIndex: 0, pageSize: 1 })).toEqual({
      ...slice,
      items: [{ id: "synthetic-1" }],
      meta: { pageIndex: 0, pageSize: 1, totalCount: 2 },
    });
    expect(
      pageProblemTypeSlice(slice, { pageIndex: 1, pageSize: 1 }),
    ).toMatchObject({
      items: [{ id: "synthetic-2" }],
      meta: { pageIndex: 1, pageSize: 1, totalCount: 2 },
    });
    expect(
      pageProblemTypeSlice(slice, { pageIndex: 3, pageSize: 1 }),
    ).toMatchObject({
      items: [],
      meta: { pageIndex: 3, pageSize: 1, totalCount: 2 },
    });
  });

  it("projects internal diagnostic ids out of problem slices", () => {
    const diagnostic = mock(referentialLivenessViolationSchema);
    const serialized = JSON.stringify(
      pageProblemTypeSlice(
        {
          type: "referentialLivenessViolations",
          items: [diagnostic],
          total: 1,
        },
        { pageIndex: 0, pageSize: 25 },
      ),
    );

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
    // An unknown problem type is answered before any database read.
    await callMcpTool(
      createMcpServer(),
      "list_problems",
      { type: "notAProblemType" },
      {},
      { telemetry: { identity, emit } },
    );
    await callMcpTool(
      createMcpServer(),
      "get_expense_analytics",
      { unknownFilter: "not-a-filter" },
      {},
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

  it("traces response bytes and partial batch outcomes separately from transport success", () => {
    const result = {
      content: [
        {
          type: "text" as const,
          text: '{"summary":{"requested":3,"succeeded":2,"failed":1}}',
        },
      ],
      structuredContent: {
        summary: { requested: 3, succeeded: 2, failed: 1 },
      },
    };

    expect(toolCallResultTraceAttributes(result)).toEqual({
      "mcp.result.is_error": false,
      "mcp.result.serialized_bytes": new TextEncoder().encode(
        JSON.stringify(result),
      ).byteLength,
      "mcp.batch.requested": 3,
      "mcp.batch.succeeded": 2,
      "mcp.batch.failed": 1,
    });
  });

  it("rejects unknown filters and semantic pairs outside the allowlist before running", async () => {
    const server = createMcpServer();
    const unknown = await callMcpTool(server, "get_expense_analytics", {
      costMinn: 500,
    });
    expect(unknown.isError).toBe(true);
    expect(JSON.stringify(unknown.content)).toContain("costMinn");

    const rejected = await callMcpTool(
      createMcpServer(),
      "find_similar_entities",
      { pair: "expense_to_product", sourceId: "PRD-2222" },
    );
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("pair");
  });

  it("explain_recipe_costing detail=lines drops both totals blocks and drift", () => {
    const explain = mock(recipeCostingExplain, {
      overrides: {
        persisted: { totals: knownTotals },
        computed: { totals: knownTotals },
      },
    });

    const full = costingExplanation(explain, "full");
    const lines = costingExplanation(explain, "lines");

    expect(full).toHaveProperty("drift");
    expect(full).toHaveProperty("computed.totals");
    expect(lines).not.toHaveProperty("drift");
    expect(lines).not.toHaveProperty("computed.totals");
    expect(lines).not.toHaveProperty("persisted.totals");
    expect(lines).toMatchObject({
      detail: "lines",
      coverage: {
        cost: explain.computed.totals.cost,
        kcal: explain.computed.totals.nutrition.kcal,
      },
      computed: { diagnostics: explain.computed.diagnostics },
    });
  });

  it("get_meal_preparations nutrition=kcal keeps cost and only the kcal estimate", () => {
    const view = mock(getMealPreparationsOut, {
      overrides: {
        preparations: [],
        totals: {
          confirmed: { totals: knownTotals },
          projected: { totals: knownTotals },
        },
      },
    });

    const kcal = mealPreparations(view, "kcal");
    const macros = mealPreparations(view, "macros");
    const none = mealPreparations(view, "none");

    expect(macros).toMatchObject({
      totals: {
        confirmed: {
          totals: {
            nutrition: {
              kcal: knownTotals.nutrition.kcal,
              protein: knownTotals.nutrition.protein,
              fiber: knownTotals.nutrition.fiber,
            },
          },
        },
      },
    });
    expect(kcal).toMatchObject({
      totals: {
        confirmed: {
          totals: {
            cost: view.totals.confirmed.totals.cost,
            nutrition: { kcal: view.totals.confirmed.totals.nutrition.kcal },
          },
        },
      },
    });
    expect(JSON.stringify(kcal).match(/"protein"/g) ?? []).toHaveLength(0);
    expect(none).toMatchObject({
      totals: {
        projected: {
          totals: { cost: view.totals.projected.totals.cost, nutrition: {} },
        },
      },
    });
    expect(JSON.stringify(none)).not.toContain('"kcal"');
  });
});
