import { mcpRecipeCreateInput, recipeMcpOut } from "@cubby/schemas/recipe";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  createMcpServer,
  listMcpToolCatalog,
  slimMeal,
  slimProduct,
  slimUsdaFood,
} from "./server";
import {
  getRegisteredTool,
  registerEntityCreateTool,
  slimRecipe,
  stripMockFromJsonSchema,
  WRITE_CLOSED,
} from "./tools/_shared";
import { registerRecipeTools } from "./tools/recipe.tools";

function schemaHasMockKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(schemaHasMockKey);
  const obj = value as Record<string, unknown>;
  if ("mock" in obj) return true;
  return Object.values(obj).some(schemaHasMockKey);
}

describe("stripMockFromJsonSchema", () => {
  it("removes mock keys recursively", () => {
    const stripped = stripMockFromJsonSchema({
      type: "object",
      properties: {
        name: { type: "string", mock: "food.ingredient" },
        nested: {
          type: "object",
          properties: { alias: { type: "string", mock: "x" } },
        },
      },
    });
    expect(schemaHasMockKey(stripped)).toBe(false);
    expect(stripped).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        nested: {
          type: "object",
          properties: { alias: { type: "string" } },
        },
      },
    });
  });
});

describe("slimProduct USDA signal", () => {
  it("surfaces usdaFdcId for a UPC-only link (no stored fdc_id)", () => {
    const slim = slimProduct({
      id: "p-1",
      name: "kosher salt",
      upc: "013600020019",
      fdc_id: null,
      food: { fdc_id: 2571981 },
    });
    expect(slim.usdaFdcId).toBe(2571981);
    expect(slim.fdc_id).toBeNull();
  });

  it("surfaces the explicit stored fdc_id link (no UPC)", () => {
    const slim = slimProduct({
      id: "p-2",
      name: "lard",
      upc: null,
      fdc_id: 999,
      food: { fdc_id: 999 },
    });
    expect(slim.usdaFdcId).toBe(999);
    expect(slim.fdc_id).toBe(999);
  });

  it("reports null usdaFdcId when nothing resolved", () => {
    const slim = slimProduct({
      id: "p-3",
      name: "Bob's Red Mill flour",
      upc: "039978533012",
      fdc_id: null,
      food: null,
    });
    expect(slim.usdaFdcId).toBeNull();
  });

  it("does not conflate externalIds with USDA linkage", () => {
    const slim = slimProduct({
      id: "p-4",
      name: "widget",
      externalIds: [{ source: "amazon", externalId: "B000" }],
      food: null,
    });
    expect(slim.usdaFdcId).toBeNull();
    expect(slim.externalIds).toEqual([
      { source: "amazon", externalId: "B000" },
    ]);
  });
});

describe("slimMeal", () => {
  it("keeps meal essentials and summarizes each planned recipe", () => {
    const slim = slimMeal({
      id: "m-1",
      date: "2026-06-20",
      name: "Dinner",
      sortOrder: 0,
      totals: { costTotal: 12, caloriesTotal: 800, pending: false },
      recipes: [
        {
          id: "mr-1",
          recipeId: "r-1",
          recipe: { id: "r-1", name: "Chili", sections: [{ huge: true }] },
          scale: 2,
          sortOrder: 0,
          scaledTotals: { costTotal: 12, caloriesTotal: 800 },
        },
      ],
    });
    expect(slim.recipes).toEqual([
      {
        id: "mr-1",
        recipeId: "r-1",
        name: "Chili",
        scale: 2,
        scaledTotals: { costTotal: 12, caloriesTotal: 800 },
      },
    ]);
    expect(slim.date).toBe("2026-06-20");
  });

  it("tolerates a meal with no recipes", () => {
    const slim = slimMeal({
      id: "m-2",
      date: "2026-06-21",
      recipes: undefined,
    });
    expect(slim.recipes).toEqual([]);
  });
});

describe("slimUsdaFood", () => {
  it("surfaces id, description, link keys, nutrients, the portion table, and branded serving", () => {
    const slim = slimUsdaFood({
      fdc_id: 2571981,
      foodInfo: { data_type: "branded_food", description: "Kosher salt" },
      brandedFoodInfo: {
        brand_owner: "Diamond Crystal",
        brand_name: "Diamond Crystal",
        gtin_upc: "013600020019",
        ingredients: "SALT",
        serving: {
          serving_size: 1,
          serving_size_unit: "g",
          household_serving_fulltext: "1/4 tsp",
        },
      },
      legacyFoodInfo: null,
      nutritionInfo: {
        nutrientsPer100: { Sodium: 39000 },
        nutrientSummary: [{ amount: 39000, name: "Sodium", unit: "mg" }],
      },
      portionInfoRaw: [{ amount: 1, modifier: "tsp", gram_weight: 6 }],
      linkedProducts: [{ id: "p-1", name: "salt", notes: "drop me" }],
    });
    expect(slim).toEqual({
      fdc_id: 2571981,
      description: "Kosher salt",
      data_type: "branded_food",
      brand_owner: "Diamond Crystal",
      brand_name: "Diamond Crystal",
      gtin_upc: "013600020019",
      ndb_number: null,
      ingredients: "SALT",
      serving: {
        serving_size: 1,
        serving_size_unit: "g",
        household_serving_fulltext: "1/4 tsp",
      },
      nutrientsPer100: { Sodium: 39000 },
      nutrientSummary: [{ amount: 39000, name: "Sodium", unit: "mg" }],
      portionInfoRaw: [{ amount: 1, modifier: "tsp", gram_weight: 6 }],
      linkedProducts: [{ id: "p-1", name: "salt" }],
    });
  });

  it("reads ndb_number from legacy foods with no brand", () => {
    const slim = slimUsdaFood({
      fdc_id: 4002,
      foodInfo: { data_type: "sr_legacy_food", description: "Lard" },
      brandedFoodInfo: null,
      legacyFoodInfo: { ndb_number: 4002 },
      nutritionInfo: { nutrientsPer100: {}, nutrientSummary: [] },
    });
    expect(slim.ndb_number).toBe(4002);
    expect(slim.gtin_upc).toBeNull();
  });
});

describe("createMcpServer registration", () => {
  it("registers all tools without throwing", () => {
    expect(() => createMcpServer()).not.toThrow();
  });

  it("stores outputSchema on create_recipe and update_recipe", () => {
    const server = createMcpServer();
    expect(
      getRegisteredTool(server, "list_recipes")?.outputSchema,
    ).toBeDefined();
    expect(
      getRegisteredTool(server, "create_recipe")?.outputSchema,
    ).toBeDefined();
    expect(
      getRegisteredTool(server, "update_recipe")?.outputSchema,
    ).toBeDefined();
  });

  it("SDK stores recipeMcpOut when registered in isolation", () => {
    const server = new McpServer({ name: "t", version: "1.0.0" });
    server.registerTool(
      "test_recipe",
      {
        description: "test",
        inputSchema: mcpRecipeCreateInput,
        outputSchema: recipeMcpOut,
      },
      async () =>
        ({
          content: [{ type: "text" as const, text: "{}" }],
          structuredContent: { id: "r-1", name: "x" },
        }) satisfies CallToolResult,
    );
    expect(
      getRegisteredTool(server, "test_recipe")?.outputSchema,
    ).toBeDefined();
  });

  it("registerEntityCreateTool stores outputSchema", () => {
    const server = new McpServer({ name: "t", version: "1.0.0" });
    registerEntityCreateTool(server, {
      name: "create_recipe",
      description: "test",
      inputSchema: mcpRecipeCreateInput,
      outputSchema: recipeMcpOut,
      slim: slimRecipe,
      annotations: WRITE_CLOSED,
      create: async () => ({ id: "r-1", name: "test" }),
    });
    expect(
      getRegisteredTool(server, "create_recipe")?.outputSchema,
    ).toBeDefined();
  });

  it("recipe tools register create_recipe outputSchema in isolation", () => {
    const server = new McpServer({ name: "t", version: "1.0.0" });
    registerRecipeTools(server);
    expect(
      getRegisteredTool(server, "create_recipe")?.outputSchema,
    ).toBeDefined();
    expect(
      getRegisteredTool(server, "update_recipe")?.outputSchema,
    ).toBeDefined();
    expect(
      getRegisteredTool(server, "list_recipes")?.outputSchema,
    ).toBeDefined();
  });
});

describe("listMcpToolCatalog", () => {
  it("advertises outputSchema on every tool with no mock metadata", async () => {
    const { tools } = await listMcpToolCatalog();
    expect(tools.length).toBeGreaterThan(50);
    const missing = tools.filter((tool) => !tool.outputSchema);
    expect(missing.map((tool) => tool.name)).toEqual([]);
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(schemaHasMockKey(tool.inputSchema)).toBe(false);
      if (tool.outputSchema) {
        expect(schemaHasMockKey(tool.outputSchema)).toBe(false);
      }
    }
  });

  it("returns structuredContent validated against outputSchema for list_locations", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "test", version: "1.0.0" });

    const mockCaller = {
      location: {
        list: async () => ({
          meta: { pageIndex: 0, pageSize: 200, totalCount: 0 },
          items: [],
        }),
      },
    };

    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      originalSend(message, {
        ...options,
        authInfo: {
          token: "",
          clientId: "test",
          scopes: [],
          extra: { caller: mockCaller },
        },
      });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const result = await client.callTool({
        name: "list_locations",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        meta: { pageIndex: 0, pageSize: 200, totalCount: 0 },
        items: [],
      });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
