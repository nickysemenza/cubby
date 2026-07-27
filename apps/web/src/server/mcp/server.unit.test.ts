import type { Entity } from "@cubby/schemas/entity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { projectOut } from "@cubby/schemas/project";
import { mcpRecipeCreateInput, recipeMcpOut } from "@cubby/schemas/recipe";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mock } from "~/lib/test/mock-schema";
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
  registerEntityCrudToolset,
  slimRecipe,
  stripMockFromJsonSchema,
  WRITE_CLOSED,
} from "./tools/_shared";
import { registerRecipeTools } from "./tools/recipe.tools";

/**
 * Call a registered tool through a real client/server InMemoryTransport pair
 * (mirrors the list_locations test below), injecting a stub tRPC caller via
 * the same authInfo.extra.caller channel the production auth layer uses.
 */
async function callTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  // biome-ignore lint/suspicious/noExplicitAny: stub tRPC caller for tool tests
  caller: any,
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: { token: "", clientId: "test", scopes: [], extra: { caller } },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

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

describe("registerEntityCrudToolset", () => {
  it("supports operation selection, names, paging, and separate outputs", async () => {
    const server = new McpServer({ name: "t", version: "1.0.0" });
    const listOut = z.object({ items: z.array(z.object({ id: z.string() })) });
    const detailOut = z.object({ id: z.string(), detail: z.string() });
    const mutationOut = z.object({ id: z.string(), changed: z.boolean() });
    registerEntityCrudToolset(server, {
      entity: "widget",
      names: { list: "search_widgets" },
      operations: { delete: false },
      paging: { defaultPageSize: 7, maxPageSize: 9 },
      createInput: { name: z.string() },
      updateShape: { name: z.string().optional() },
      filterFields: { search: z.string().optional() },
      mcpListOut: listOut,
      out: mutationOut,
      detailOut,
      mutationOut,
      slim: (value) => value as Record<string, unknown>,
      sort: { orderBy: "name" },
      descriptions: {
        list: "list",
        get: "get",
        create: "create",
        update: "update",
        delete: "delete",
      },
    });

    expect(getRegisteredTool(server, "search_widgets")?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const list = vi.fn().mockResolvedValue({ meta: {}, items: [] });
    await callTool(server, "search_widgets", {}, { widget: { list } });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        pagination: { pageIndex: 0, pageSize: 7 },
      }),
    );
    expect(getRegisteredTool(server, "get_widget")?.outputSchema).toBe(
      detailOut,
    );
    expect(getRegisteredTool(server, "create_widget")?.outputSchema).toBe(
      mutationOut,
    );
    expect(getRegisteredTool(server, "update_widget")?.outputSchema).toBe(
      mutationOut,
    );
    expect(getRegisteredTool(server, "delete_widgets")).toBeUndefined();
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
  it("keeps manifest MCP operations aligned with registered tools", async () => {
    type Operation = "list" | "get" | "create" | "update" | "delete";
    const slugs: Record<
      Entity,
      [
        singular: string,
        plural: string,
        overrides?: Partial<Record<Operation, string>>,
      ]
    > = {
      product: ["product", "products", { list: "search_products" }],
      recipe: ["recipe", "recipes", { delete: "delete_recipe" }],
      ingredient: ["ingredient", "ingredients", { list: "search_ingredients" }],
      cookbook: ["cookbook", "cookbooks"],
      location: ["location", "locations"],
      inventory: [
        "inventory_entry",
        "inventory_entries",
        { list: "list_inventory" },
      ],
      meal: ["meal", "meals"],
      project: ["project", "projects"],
      task: ["task", "tasks"],
      purchase: ["purchase", "purchases"],
      "usda-food": ["usda_food", "usda_foods", { list: "search_usda_foods" }],
      image: ["image", "images"],
    };
    const catalog = new Set(
      (await listMcpToolCatalog()).tools.map(({ name }) => name),
    );

    for (const entity of allEntities) {
      const [singular, plural, overrides = {}] = slugs[entity];
      for (const operation of entityManifest[entity].mcp) {
        const defaultSlug =
          operation === "list" || operation === "delete" ? plural : singular;
        expect(
          catalog.has(overrides[operation] ?? `${operation}_${defaultSlug}`),
        ).toBe(true);
      }
    }
  });

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

  it("advertises real JSON Schema properties for every tool", async () => {
    // Regression: `safeToJsonSchema` used to catch conversion failures and fall
    // back to an opaque `{type: "object", additionalProperties: true}`. Any
    // schema reaching a `z.date()` (timestampedFields, totalsComputedAt,
    // lastBulkInventory, …) tripped it, degrading 22 tools silently. A tool
    // whose advertised schema has no `properties` means the fallback fired.
    const { tools } = await listMcpToolCatalog();
    const degraded = tools.filter((tool) =>
      [tool.inputSchema, tool.outputSchema].some(
        (schema) =>
          schema !== undefined &&
          (schema as Record<string, unknown>).properties === undefined,
      ),
    );
    expect(degraded.map((tool) => tool.name)).toEqual([]);
  });

  it("advertises dates as date-time strings and emits them on the wire", async () => {
    const catalog = await listMcpToolCatalog();
    const getProject = catalog.tools.find(
      (tool) => tool.name === "get_project",
    );
    const advertised = getProject?.outputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(advertised?.properties?.createdAt).toEqual({
      type: "string",
      format: "date-time",
    });

    // …and the value a client actually receives matches that advertisement:
    // structuredContent carries a real Date, which JSON-RPC serializes to ISO.
    const createdAt = new Date("2026-07-27T12:34:56.000Z");
    const project = mock(projectOut, { seed: 1, overrides: { createdAt } });
    const result = await callTool(
      createMcpServer(),
      "get_project",
      { id: project.id },
      { project: { getByID: async () => project } },
    );

    expect(result.isError).not.toBe(true);
    // InMemoryTransport hands the object over unserialized, so assert on the
    // JSON a real transport would produce rather than on the in-process value.
    expect(JSON.parse(JSON.stringify(result.structuredContent)).createdAt).toBe(
      "2026-07-27T12:34:56.000Z",
    );
    expect(
      JSON.parse(
        ((result.content as CallToolResult["content"])[0] as { text: string })
          .text,
      ).createdAt,
    ).toBe("2026-07-27T12:34:56.000Z");
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

describe("merge_ingredients partial-success aggregation", () => {
  const TARGET_A = "11111111-1111-4111-8111-111111111111";
  const ALIAS_A = "11111111-1111-4111-8111-111111111112";
  const TARGET_B = "22222222-2222-4222-8222-222222222222";
  const ALIAS_B = "22222222-2222-4222-8222-222222222223";

  it("reports merged/total/results and leaves isError unset when at least one merge succeeds", async () => {
    const mergeSummary = {
      aliasesAdded: ["Cherry"],
      recipesMoved: 2,
      productsMoved: 1,
      deletedIds: [ALIAS_A],
    };
    const caller = {
      ingredient: {
        merge: vi
          .fn()
          .mockResolvedValueOnce({ mergeSummary })
          .mockRejectedValueOnce(new Error("target not found")),
      },
    };

    const result = await callTool(
      createMcpServer(),
      "merge_ingredients",
      {
        merges: [
          { target: TARGET_A, aliases: [ALIAS_A] },
          { target: TARGET_B, aliases: [ALIAS_B] },
        ],
      },
      caller,
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      merged: 1,
      total: 2,
      results: [
        { target: TARGET_A, ok: true, summary: mergeSummary },
        { target: TARGET_B, ok: false, error: "target not found" },
      ],
    });
  });

  it("sets isError only when every merge in the batch fails", async () => {
    const caller = {
      ingredient: {
        merge: vi.fn().mockRejectedValue(new Error("boom")),
      },
    };

    const result = await callTool(
      createMcpServer(),
      "merge_ingredients",
      {
        merges: [
          { target: TARGET_A, aliases: [ALIAS_A] },
          { target: TARGET_B, aliases: [ALIAS_B] },
        ],
      },
      caller,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      merged: 0,
      total: 2,
      results: [
        { target: TARGET_A, ok: false, error: "boom" },
        { target: TARGET_B, ok: false, error: "boom" },
      ],
    });
  });

  it("does not flag isError on a fully-successful batch", async () => {
    const mergeSummary = {
      aliasesAdded: [],
      recipesMoved: 0,
      productsMoved: 0,
      deletedIds: [ALIAS_A],
    };
    const caller = {
      ingredient: {
        merge: vi.fn().mockResolvedValue({ mergeSummary }),
      },
    };

    const result = await callTool(
      createMcpServer(),
      "merge_ingredients",
      { merges: [{ target: TARGET_A, aliases: [ALIAS_A] }] },
      caller,
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      merged: 1,
      total: 1,
      results: [{ target: TARGET_A, ok: true, summary: mergeSummary }],
    });
  });
});

describe("update_inventory_entry value/unit pairing guard", () => {
  const ENTRY_ID = "33333333-3333-4333-8333-333333333333";

  it("throws before reaching the router when only value is supplied", async () => {
    const caller = { inventory: { update: vi.fn() } };

    const result = await callTool(
      createMcpServer(),
      "update_inventory_entry",
      { id: ENTRY_ID, value: 3 },
      caller,
    );

    expect(result.isError).toBe(true);
    expect(caller.inventory.update).not.toHaveBeenCalled();
    const [content] = result.content as Array<{ type: string; text?: string }>;
    expect(content?.text).toContain(
      "Both value and unit must be provided together",
    );
  });

  it("throws before reaching the router when only unit is supplied", async () => {
    const caller = { inventory: { update: vi.fn() } };

    const result = await callTool(
      createMcpServer(),
      "update_inventory_entry",
      { id: ENTRY_ID, unit: "each" },
      caller,
    );

    expect(result.isError).toBe(true);
    expect(caller.inventory.update).not.toHaveBeenCalled();
  });

  it("passes both through when value and unit are supplied together", async () => {
    const updated = {
      id: ENTRY_ID,
      amount: { value: 3, unit: "each" },
      valuation: null,
      product: null,
      location: null,
    };
    const caller = {
      inventory: { update: vi.fn().mockResolvedValue(updated) },
    };

    const result = await callTool(
      createMcpServer(),
      "update_inventory_entry",
      { id: ENTRY_ID, value: 3, unit: "each" },
      caller,
    );

    expect(result.isError).not.toBe(true);
    expect(caller.inventory.update).toHaveBeenCalledWith({
      id: ENTRY_ID,
      data: { amount: { value: 3, unit: "each" } },
    });
  });
});
