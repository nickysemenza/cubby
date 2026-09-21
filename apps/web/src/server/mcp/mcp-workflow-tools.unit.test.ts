import { referentialLivenessViolationSchema } from "@cubby/schemas/entity-integrity";
import { mealRecipeId as mealRecipeIdSchema } from "@cubby/schemas/identifiers";
import { problemsCountSchema } from "@cubby/schemas/mcp";
import {
  mealNutritionOut,
  mealOut,
  nutritionMeal,
  getMealPreparationsOut,
} from "@cubby/schemas/meal";
import {
  buildNutrition,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import { productResolveNamesOut } from "@cubby/schemas/product";
import { expenseAnalyticsOut } from "@cubby/schemas/project";
import {
  recipeCostingExplain,
  rowDiagnostic,
} from "@cubby/schemas/recipe-shared";
import { similarEntitiesOut } from "@cubby/schemas/search";
import type { McpToolCallTelemetry } from "@cubby/schemas/telemetry";
import { testShortcode } from "@cubby/schemas/testing";
import { SHORTCODE_PREFIX } from "@cubby/shared";
import { describe, expect, it, vi } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import { callMcpTool } from "./mcp-test-utils";
import { createMcpServer, MCP_SERVER_INSTRUCTIONS } from "./server";
import {
  buildRecipeNutrition,
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

  it("add_recipe_to_meal defaults to compact coverage and opts into nutrition", async () => {
    const meal = mock(mealOut, {
      overrides: { name: "Dinner", totals: knownTotals, recipes: [] },
    });
    const mealRecipeId = mealRecipeIdSchema.parse(
      "00000000-0000-4000-8000-000000000001",
    );
    const addRecipe = vi.fn(async () => ({ meal, mealRecipeId }));
    const server = createMcpServer();
    const params = {
      mealId: meal.id,
      recipeId: testShortcode("recipe", "meal-recipe"),
    };

    const compact = await callMcpTool(server, "add_recipe_to_meal", params, {
      meal: { addRecipe },
    });
    const macros = await callMcpTool(
      server,
      "add_recipe_to_meal",
      { ...params, nutrition: "macros" },
      { meal: { addRecipe } },
    );

    expect(compact.isError).not.toBe(true);
    expect(compact.structuredContent).toEqual({
      id: meal.id,
      mealRecipeId,
      name: "Dinner",
      coverage: { cost: 1.5, kcal: 120 },
    });
    expect(macros.structuredContent).toMatchObject({
      coverage: { cost: 1.5, kcal: 120 },
      nutrition: { kcal: 120, protein: "pending" },
    });
  });

  it("create_file_uploads preserves indexes across partial runtime failures", async () => {
    const firstUploadId = testShortcode("image", "upload-first");
    const thirdUploadId = testShortcode("image", "upload-third");
    const createFileUpload = vi.fn(async (input: { filename: string }) => {
      if (input.filename === "invalid.txt") {
        throw new Error("Unsupported file type: text/plain");
      }
      const uploadId =
        input.filename === "first.jpg" ? firstUploadId : thirdUploadId;
      return {
        uploadId,
        uploadUrl: `https://uploads.example.test/${uploadId}`,
      };
    });

    const result = await callMcpTool(
      createMcpServer(),
      "create_file_uploads",
      {
        items: [
          {
            entityId: "PRD-2ABC",
            filename: "first.jpg",
            contentType: "image/jpeg",
            size: 10,
          },
          {
            entityId: "PRD-2ABC",
            filename: "invalid.txt",
            contentType: "text/plain",
            size: 11,
          },
          {
            entityId: "PRD-2ABC",
            filename: "third.jpg",
            contentType: "image/jpeg",
            size: 12,
          },
        ],
      },
      { image: { createFileUpload } },
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      summary: { requested: 3, succeeded: 2, failed: 1 },
      results: [
        {
          index: 0,
          status: "succeeded",
          reference: firstUploadId,
          item: {
            uploadId: firstUploadId,
            uploadUrl: `https://uploads.example.test/${firstUploadId}`,
          },
        },
        {
          index: 1,
          status: "failed",
          error: expect.objectContaining({
            message: "Unsupported file type: text/plain",
            code: "INTERNAL_SERVER_ERROR",
            diagnostics: expect.objectContaining({
              operation: "create_file_uploads",
              batchIndex: 1,
              stage: "run",
            }),
          }),
        },
        {
          index: 2,
          status: "succeeded",
          reference: thirdUploadId,
          item: {
            uploadId: thirdUploadId,
            uploadUrl: `https://uploads.example.test/${thirdUploadId}`,
          },
        },
      ],
    });
  });

  it("attach_files exposes idempotent replay outcomes without base64", async () => {
    const entityId = testShortcode("product", "attach-target");
    const imageId = testShortcode("image", "attached-image");
    let attached = false;
    const attachFile = vi.fn(
      async (input: { idempotencyKey?: string; entityId: string }) => {
        const reused = attached;
        attached = true;
        return {
          imageId,
          url: "https://images.example.test/item.jpg",
          filename: "item.jpg",
          contentType: "image/jpeg",
          kind: "image" as const,
          entityType: "product" as const,
          entityId,
          idempotencyKey: input.idempotencyKey,
          reused,
        };
      },
    );
    const args = {
      items: [
        {
          entityId,
          url: "https://source.example.test/item.jpg",
          idempotencyKey: "stable-item-key",
        },
      ],
    };

    const first = await callMcpTool(createMcpServer(), "attach_files", args, {
      image: { attachFile },
    });
    const replay = await callMcpTool(createMcpServer(), "attach_files", args, {
      image: { attachFile },
    });

    expect(first.structuredContent).toMatchObject({
      summary: { requested: 1, succeeded: 1, failed: 0 },
      results: [{ index: 0, status: "succeeded", item: { reused: false } }],
    });
    expect(replay.structuredContent).toMatchObject({
      summary: { requested: 1, succeeded: 1, failed: 0 },
      results: [{ index: 0, status: "succeeded", item: { reused: true } }],
    });
    expect(attachFile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entityId,
        entityType: "product",
        idempotencyKey: "stable-item-key",
      }),
    );
  });

  it("reads compact daily macros for one eater and only includes foods on request", async () => {
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
    const getNutrition = vi.fn(async () => view);
    const params = { date: "2000-01-01", partyId: person.eater.id };
    const compact = await callMcpTool(
      createMcpServer(),
      "get_daily_intake",
      params,
      { meal: { getNutrition } },
    );
    expect(compact.isError).not.toBe(true);
    expect(getNutrition).toHaveBeenCalledExactlyOnceWith({ date: params.date });
    const macros = {
      kcal: 120,
      protein: { lower: 12, upper: null, partial: true },
      carbs: "pending",
      fat: 0,
      fiber: null,
    };
    expect(compact.structuredContent).toEqual({
      ...params,
      status: "logged",
      nutrition: macros,
      meals: [
        {
          mealId: meal.id,
          name: meal.name,
          nutrition: macros,
        },
      ],
    });
    const full = await callMcpTool(
      createMcpServer(),
      "get_daily_intake",
      { ...params, date: "2099-01-01", nutrition: "full", includeFoods: true },
      { meal: { getNutrition } },
    );
    expect(full.isError).not.toBe(true);
    expect(full.structuredContent).toMatchObject({
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
    expect(JSON.stringify(compact.structuredContent).length).toBeLessThan(
      JSON.stringify(full.structuredContent).length,
    );
  });

  it("keeps a day with no assigned intake unavailable rather than inventing zero", async () => {
    const partyId = testShortcode("ledgerParty", "empty-intake");
    const result = await callMcpTool(
      createMcpServer(),
      "get_daily_intake",
      { date: "2000-01-01", partyId },
      { meal: { getNutrition: async () => ({ meals: [], people: [] }) } },
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      date: "2000-01-01",
      partyId,
      status: "logged",
      nutrition: null,
      meals: [],
    });
  });

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

  it("defaults unscoped problem triage to counts and pages an explicit type report", async () => {
    const getCounts = vi.fn(async () => mock(problemsCountSchema));
    const getByType = vi.fn(async () => ({
      type: "orphanedProducts" as const,
      items: [{ id: "synthetic-1" }, { id: "synthetic-2" }],
      total: 2,
    }));
    const counts = await callMcpTool(
      createMcpServer(),
      "list_problems",
      {},
      { problems: { getCounts, getByType } },
    );
    const page = await callMcpTool(
      createMcpServer(),
      "list_problems",
      {
        countsOnly: false,
        type: "orphanedProducts",
        pageIndex: 0,
        pageSize: 1,
      },
      { problems: { getCounts, getByType } },
    );

    expect(counts.isError).not.toBe(true);
    expect(getCounts).toHaveBeenCalledOnce();
    expect(getByType).toHaveBeenCalledOnce();
    expect(page.structuredContent).toEqual({
      type: "orphanedProducts" as const,
      items: [{ id: "synthetic-1" }],
      total: 2,
      meta: { pageIndex: 0, pageSize: 1, totalCount: 2 },
    });

    const finalPage = await callMcpTool(
      createMcpServer(),
      "list_problems",
      { type: "orphanedProducts", pageIndex: 1, pageSize: 1 },
      { problems: { getByType } },
    );
    const emptyPage = await callMcpTool(
      createMcpServer(),
      "list_problems",
      { type: "orphanedProducts", pageIndex: 3, pageSize: 1 },
      { problems: { getByType } },
    );
    const explicitCounts = await callMcpTool(
      createMcpServer(),
      "list_problems",
      { countsOnly: true, type: "orphanedProducts" },
      { problems: { getCounts, getByType } },
    );
    expect(finalPage.structuredContent).toMatchObject({
      items: [{ id: "synthetic-2" }],
      meta: { pageIndex: 1, pageSize: 1, totalCount: 2 },
    });
    expect(emptyPage.structuredContent).toMatchObject({
      items: [],
      meta: { pageIndex: 3, pageSize: 1, totalCount: 2 },
    });
    expect(explicitCounts.isError).not.toBe(true);
  });

  it("projects internal diagnostic ids out of problem slices", async () => {
    const diagnostic = mock(referentialLivenessViolationSchema);
    const result = await callMcpTool(
      createMcpServer(),
      "list_problems",
      { countsOnly: false, type: "referentialLivenessViolations" },
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

  it("uses the execution caller for MCP search tools", async () => {
    const similar = vi.fn(async () =>
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
      { search: { similar } },
    );

    expect(result.isError).not.toBe(true);
    expect(similar).toHaveBeenCalledOnce();
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
      { id: "RCP-4K7M", detail: "full" },
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
    const macros = await callMcpTool(
      server,
      "get_meal_preparations",
      { mealId: view.mealId, nutrition: "macros" },
      { meal: { getPreparations } },
    );
    expect(macros.isError).not.toBe(true);
    expect(macros.structuredContent).toMatchObject({
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
