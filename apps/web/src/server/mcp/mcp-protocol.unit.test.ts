import { mcpToolName } from "@cubby/schemas/entity-manifest";
import { ingredientWithFoodOut } from "@cubby/schemas/ingredient";
import { mealOut, mealRecipeOut } from "@cubby/schemas/meal";
import {
  buildNutrition,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import {
  productTopLevelOut,
  productWithFoodOut,
  productWithMappingsAndFoodOut,
} from "@cubby/schemas/product";
import { recipeTopLevel } from "@cubby/schemas/recipe-shared";
import { foodSummary } from "@cubby/usda-schemas";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import {
  ENTITY_KERNEL_ENTITIES,
  entityMcpReadCommandSchema,
} from "~/server/entity-kernel/contracts";

import { callMcpTool } from "./mcp-test-utils";
import { listMcpResourceCatalog, listMcpToolCatalog } from "./server";
import { type ExecuteEntity, registerEntityTools } from "./tools/entity.tools";
import { projectEntityResult } from "./tools/response-projection";

describe("MCP protocol smoke", () => {
  it("publishes command and read-only entity capabilities with a discoverable catalog", async () => {
    const [{ tools }, { resources }] = await Promise.all([
      listMcpToolCatalog(),
      listMcpResourceCatalog(),
    ]);
    const names = new Set(tools.map((tool) => tool.name));
    const entityInput = z
      .object({
        properties: z.object({ command: z.json().optional() }).optional(),
      })
      .parse(tools.find((tool) => tool.name === "entity")?.inputSchema);

    expect(names).toContain("entity");
    expect(names).toContain("get_entities");
    expect(
      tools.find((tool) => tool.name === "get_entities")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    expect(resources.map((resource) => resource.uri)).toContain(
      "entities://catalog",
    );
    expect(entityInput.properties?.command).toBeDefined();
    for (const entity of ENTITY_KERNEL_ENTITIES) {
      for (const operation of ["list", "get", "create", "update"] as const) {
        expect(names).not.toContain(mcpToolName(entity, operation));
      }
    }
    expect(names).toContain("move_inventory_entries");
    expect(names).not.toContain("start_planting");
    expect(names).not.toContain("move_planting");
    expect(names).not.toContain("finish_planting");
    expect(names).not.toContain("delete_entity");
    expect(names).not.toContain("attach_entity");
    expect(names).not.toContain("detach_entity");
    expect(names).not.toContain("merge_entity");
  });

  it.each([
    "create",
    "update",
    "delete",
    "merge",
    "bulkUpdate",
    "attach",
    "detach",
  ])("rejects %s at the read-only command boundary", (action) => {
    expect(
      entityMcpReadCommandSchema.safeParse({
        action,
        entity: "ingredient",
        id: "ING-2ABC",
        data: {},
        ids: ["ING-2ABC"],
      }).success,
    ).toBe(false);
  });

  it("dispatches entity commands through the explicit kernel capability", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const runEntity: ExecuteEntity = vi.fn(async (_context, command) => {
      expect(command).toMatchObject({ action: "list", entity: "expense" });
      return {
        action: "list" as const,
        entity: "expense" as const,
        items: [],
        meta: { pageIndex: 0, pageSize: 10, totalCount: 0 },
      };
    });
    const recordDatabaseWrite = vi.fn(async () => {});
    registerEntityTools(server, runEntity, {
      markCalendarDirty: vi.fn(),
      recordDatabaseWrite,
    });

    // The tool boundary validates the injected kernel capability before it
    // dispatches. The executor is mocked here, so only that capability shape
    // is exercised, not a database-backed operation.
    const entityKernel = {
      db: null,
      readDb: null,
      actorContext: null,
      usdaClient: null,
      upcLookupClient: null,
      services: null,
    };

    const result = await callMcpTool(
      server,
      "entity",
      { command: { action: "list", entity: "expense" } },
      {},
      { entityKernel },
    );

    expect(result.isError).not.toBe(true);
    expect(runEntity).toHaveBeenCalledOnce();
    expect(result.structuredContent).toMatchObject({
      action: "list",
      entity: "expense",
      meta: { pageIndex: 0, pageSize: 10, totalCount: 0 },
    });
    expect(recordDatabaseWrite).not.toHaveBeenCalled();
  });

  it("materializes entity list pagination and rejects invalid boundaries", () => {
    expect(
      entityMcpReadCommandSchema.parse({ action: "list", entity: "expense" }),
    ).toMatchObject({ pagination: { pageIndex: 0, pageSize: 10 } });
    for (const pagination of [
      { pageIndex: -1, pageSize: 10 },
      { pageIndex: 0, pageSize: 501 },
      { pageIndex: 0.5, pageSize: 10 },
    ]) {
      expect(
        entityMcpReadCommandSchema.safeParse({
          action: "list",
          entity: "expense",
          pagination,
        }).success,
      ).toBe(false);
    }
  });

  it.each([
    ["cookbook", { id: "CBK-2ABC", book: "Synthetic book" }, "Synthetic book"],
    [
      "purchase",
      { id: "PUR-2ABC", displayName: "Synthetic receipt" },
      "Synthetic receipt",
    ],
    [
      "ledgerTransfer",
      { id: "LTR-2ABC", fromPartyName: "Synthetic transfer" },
      "Synthetic transfer",
    ],
  ] as const)(
    "derives a %s summary name from its manifest title field",
    (entity, item, name) => {
      expect(
        projectEntityResult(
          { resultDetail: "summary" },
          { action: "get", entity, item },
        ),
      ).toMatchObject({ item: { id: item.id, name } });
    },
  );

  it("retains write coverage in summary results", () => {
    expect(
      projectEntityResult(
        { resultDetail: "summary" },
        {
          action: "update",
          entity: "product",
          item: {
            id: "PRD-2ABC",
            name: "Synthetic product",
            dataQuality: {
              status: "needs_attention",
              gaps: [
                { check: "cover", kind: "missing" },
                { check: "barcode", kind: "defect" },
              ],
            },
          },
        },
      ),
    ).toMatchObject({
      item: {
        coverage: {
          status: "needs_attention",
          missingChecks: ["cover"],
          defectChecks: ["barcode"],
        },
      },
    });
  });

  it("defaults entity reads to identity summaries and keeps compact product ids", async () => {
    const product = mock(productWithFoodOut, {
      overrides: {
        externalIds: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            source: "amazon",
            kind: "asin",
            externalId: "B012345678",
            url: "https://www.amazon.com/dp/B012345678",
            isPrimary: true,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
        ],
      },
    });
    const runEntity: ExecuteEntity = async () => ({
      action: "get",
      entity: "product",
      item: {
        ...product,
        displayImages: [],
        attachments: [],
        redirectedFrom: null,
        previousShortcodes: [],
      },
    });
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerEntityTools(server, runEntity);

    const result = await callMcpTool(
      server,
      "get_entities",
      { command: { action: "get", entity: "product", id: product.id } },
      {},
      {
        entityKernel: {
          db: null,
          readDb: null,
          actorContext: null,
          usdaClient: null,
          upcLookupClient: null,
          services: null,
        },
      },
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      action: "get",
      entity: "product",
      item: {
        id: product.id,
        name: product.name,
        externalIds: [
          {
            source: "amazon",
            kind: "asin",
            externalId: "B012345678",
            isPrimary: true,
          },
        ],
      },
    });
  });

  it("keeps explicit full entity reads complete and measures the compact default", async () => {
    const product = mock(productWithFoodOut, {
      overrides: { externalIds: [], notes: "synthetic detail ".repeat(40) },
    });
    const runEntity: ExecuteEntity = async () => ({
      action: "get",
      entity: "product",
      item: {
        ...product,
        displayImages: [],
        attachments: [],
        redirectedFrom: null,
        previousShortcodes: [],
      },
    });
    const summaryServer = new McpServer({ name: "test", version: "1.0.0" });
    const fullServer = new McpServer({ name: "test", version: "1.0.0" });
    registerEntityTools(summaryServer, runEntity);
    registerEntityTools(fullServer, runEntity);
    const extra = {
      entityKernel: {
        db: null,
        readDb: null,
        actorContext: null,
        usdaClient: null,
        upcLookupClient: null,
        services: null,
      },
    };
    const [summary, full] = await Promise.all([
      callMcpTool(
        summaryServer,
        "get_entities",
        { command: { action: "get", entity: "product", id: product.id } },
        {},
        extra,
      ),
      callMcpTool(
        fullServer,
        "get_entities",
        {
          command: {
            action: "get",
            entity: "product",
            id: product.id,
            resultDetail: "full",
          },
        },
        {},
        extra,
      ),
    ]);
    const summaryJson = JSON.stringify(summary.structuredContent);
    const fullJson = JSON.stringify(full.structuredContent);
    expect(summaryJson.length).toBeLessThan(fullJson.length);
    expect(fullJson).toContain(product.notes);
    expect(summary.content).toEqual([{ type: "text", text: summaryJson }]);
    expect(full.content).toEqual([{ type: "text", text: fullJson }]);
  });

  it("projects storage-only child ids out of generic entity results", async () => {
    const totals: NutritionTotals = withMacros({
      cost: { status: "unavailable", reason: "no_data" },
      nutrition: buildNutrition((key) =>
        key === "sodium"
          ? {
              status: "complete",
              lower: 0,
              upper: null,
              coverage: { covered: 1, total: 1 },
            }
          : { status: "pending", reason: "totals_missing" },
      ),
    });
    const mealRecipe = mock(mealRecipeOut, {
      overrides: { scaledTotals: totals },
    });
    const meal = mock(mealOut, {
      overrides: { recipes: [mealRecipe], totals },
    });
    const runEntity: ExecuteEntity = async () => ({
      action: "list",
      entity: "meal",
      items: [{ ...meal, displayImages: [] }],
      meta: { pageIndex: 0, pageSize: 10, totalCount: 1 },
    });
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerEntityTools(server, runEntity);

    const result = await callMcpTool(
      server,
      "entity",
      { command: { action: "list", entity: "meal", resultDetail: "full" } },
      {},
      {
        entityKernel: {
          db: null,
          readDb: null,
          actorContext: null,
          usdaClient: null,
          upcLookupClient: null,
          services: null,
        },
      },
    );
    const serialized = JSON.stringify(result.structuredContent);

    expect(result.isError).not.toBe(true);
    expect(serialized).not.toContain(mealRecipe.id);
    expect(serialized).toContain(mealRecipe.recipeId);
    expect(result.structuredContent).toMatchObject({
      items: [
        {
          totals: {
            nutrition: {
              sodium: { status: "complete", lower: 0 },
              protein: { status: "pending" },
            },
          },
        },
      ],
    });
  });

  const nullKernel = {
    entityKernel: {
      db: null,
      readDb: null,
      actorContext: null,
      usdaClient: null,
      upcLookupClient: null,
      services: null,
    },
  };

  it("drops the full USDA nutrient table from product and ingredient reads", async () => {
    const food = mock(foodSummary);
    expect(food.nutritionInfo.nutrientSummary).toBeDefined();
    // `externalIds: []` — the generator can't satisfy the source-slug refine.
    const product = mock(productWithFoodOut, {
      overrides: { food, externalIds: [] },
    });
    const embedded = mock(productWithMappingsAndFoodOut, {
      overrides: { food, externalIds: [] },
    });
    const recipe = mock(recipeTopLevel, {
      overrides: { notes: "a headnote that repeats once per usage row" },
    });
    const ingredient = mock(ingredientWithFoodOut, {
      overrides: {
        recipe,
        appearsInRecipes: [recipe],
        recipeUsages: [
          {
            ...mock(ingredientWithFoodOut, {
              overrides: { product: [], appearsInRecipes: [] },
            }).recipeUsages[0]!,
            recipe,
          },
        ],
        product: [embedded],
      },
    });
    const runEntity: ExecuteEntity = async (_context, command) =>
      command.entity === "product"
        ? {
            action: "get",
            entity: "product",
            item: {
              ...product,
              displayImages: [],
              attachments: [],
              redirectedFrom: null,
              previousShortcodes: [],
            },
          }
        : {
            action: "get",
            entity: "ingredient",
            item: { ...ingredient, displayImages: [], attachments: [] },
          };
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerEntityTools(server, runEntity);

    const productRead = await callMcpTool(
      server,
      "get_entities",
      {
        command: {
          action: "get",
          entity: "product",
          id: product.id,
          resultDetail: "full",
        },
      },
      {},
      nullKernel,
    );
    const ingredientRead = await callMcpTool(
      server,
      "get_entities",
      {
        command: {
          action: "get",
          entity: "ingredient",
          id: ingredient.id,
          resultDetail: "full",
        },
      },
      {},
      nullKernel,
    );

    expect(productRead.isError).not.toBe(true);
    expect(ingredientRead.isError).not.toBe(true);
    const productJson = JSON.stringify(productRead.structuredContent);
    const ingredientJson = JSON.stringify(ingredientRead.structuredContent);
    expect(productJson).not.toContain("nutrientSummary");
    expect(productJson).toContain("nutrientsPer100");
    expect(ingredientJson).not.toContain("nutrientSummary");
    expect(ingredientJson).not.toContain("a headnote that repeats");
    expect(ingredientJson).toContain(recipe.id);
  });

  it("runs entity_batch items independently and reports each outcome", async () => {
    const created = mock(productTopLevelOut, {
      overrides: { externalIds: [] },
    });
    const runEntity = vi.fn<ExecuteEntity>(async (_context, command) => {
      if (command.action !== "create" || command.entity !== "product")
        throw new Error("unexpected command");
      if (command.data.name === "boom") throw new Error("simulated failure");
      return {
        action: "create",
        entity: "product",
        item: { ...created, name: command.data.name },
        sideEffects: { backgroundBatches: [] },
      };
    });
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const recordDatabaseWrite = vi.fn(async () => {});
    registerEntityTools(server, runEntity, {
      markCalendarDirty: vi.fn(),
      recordDatabaseWrite,
    });

    const result = await callMcpTool(
      server,
      "entity_batch",
      {
        items: [
          { action: "create", entity: "product", data: { name: "first" } },
          { action: "create", entity: "product", data: { name: "boom" } },
          { action: "create", entity: "product", data: { name: "third" } },
        ],
      },
      {},
      nullKernel,
    );

    expect(result.isError).not.toBe(true);
    expect(runEntity).toHaveBeenCalledTimes(3);
    expect(result.structuredContent).toMatchObject({
      summary: { requested: 3, succeeded: 2, failed: 1 },
      results: [
        { index: 0, status: "succeeded", reference: created.id },
        { index: 1, status: "failed" },
        { index: 2, status: "succeeded", reference: created.id },
      ],
    });
    expect(recordDatabaseWrite).toHaveBeenCalledOnce();
    expect(recordDatabaseWrite).toHaveBeenCalledWith("mcp.entity_batch");
  });
});
