import type { Entity } from "@cubby/schemas/entity";
import { allEntities, entityManifest } from "@cubby/schemas/entity-manifest";
import { unsafeExpenseId } from "@cubby/schemas/identifiers";
import type { ExpenseMatchCandidate } from "@cubby/schemas/project";
import {
  expenseOut,
  MATCH_MAX_ROWS,
  projectDashboardSummaryOut,
  projectOut,
  taskOut,
} from "@cubby/schemas/project";
import { mcpRecipeCreateInput, recipeMcpOut } from "@cubby/schemas/recipe";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mock } from "~/lib/test/mock-schema";
import { SHOPPING_LIST_UI, USDA_PICKER_UI } from "./apps";
import {
  createMcpServer,
  listMcpResourceCatalog,
  listMcpToolCatalog,
  slimMeal,
  slimProduct,
  slimUsdaFood,
} from "./server";
import {
  getRegisteredTool,
  installMockStrippedListToolsHandler,
  registerEntityCreateTool,
  registerEntityCrudToolset,
  registerMcpTool,
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
      expense: ["expense", "expenses"],
      // vendor/purchase expose get/list/create/update but NOT delete, so the
      // loop below never asks for delete_vendors / delete_purchases. Note that
      // `purchase` here is the vendor CHARGE, not the old flat ledger row —
      // that one is `expense` above, and it is the one that owns money.
      vendor: ["vendor", "vendors"],
      purchase: ["purchase", "purchases"],
      "usda-food": ["usda_food", "usda_foods", { list: "search_usda_foods" }],
      image: ["image", "images"],
    };
    const catalog = new Set(
      (await listMcpToolCatalog()).tools.map(({ name }) => name),
    );

    const OPERATIONS: Operation[] = [
      "list",
      "get",
      "create",
      "update",
      "delete",
    ];

    for (const entity of allEntities) {
      const [singular, plural, overrides = {}] = slugs[entity];
      const declared = new Set<Operation>(entityManifest[entity].mcp);
      // Both directions: a declared op must be registered, and an UNDECLARED op
      // must not be. The negative half is what guards the deliberate omissions —
      // vendor/purchase have no delete tool on purpose (see the manifest), and
      // without this a stray registration would pass unnoticed.
      for (const operation of OPERATIONS) {
        const defaultSlug =
          operation === "list" || operation === "delete" ? plural : singular;
        const toolName = overrides[operation] ?? `${operation}_${defaultSlug}`;
        expect({
          entity,
          operation,
          toolName,
          registered: catalog.has(toolName),
        }).toEqual({
          entity,
          operation,
          toolName,
          registered: declared.has(operation),
        });
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
    //
    // Supersedes an earlier per-tool spot-check of the tracker synthesis/bulk
    // tools (get_house_status, bulk_move_tasks, …) — those derived
    // pick/omit/extend shapes are covered here along with everything else.
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

    // Same for a date nested inside an array item (get_recent_activity's
    // auditLogEntryOut.createdAt) — the override walks the whole schema, not
    // just top-level properties.
    const recentActivity = catalog.tools.find(
      (tool) => tool.name === "get_recent_activity",
    );
    const entries = (
      recentActivity?.outputSchema as {
        properties?: {
          entries?: { items?: { properties?: Record<string, unknown> } };
        };
      }
    )?.properties?.entries;
    expect(entries?.items?.properties?.createdAt).toEqual({
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

describe("find_similar_entities pair allowlist", () => {
  const EXPENSE_A = "77777777-7777-4777-8777-777777777771";

  it("passes an allowlisted pair through to search.similar", async () => {
    const similar = vi.fn().mockResolvedValue({
      source: { entityType: "expense", entityId: EXPENSE_A },
      results: [],
    });

    const result = await callTool(
      createMcpServer(),
      "find_similar_entities",
      { pair: "expense_to_product", sourceId: EXPENSE_A, limit: 3 },
      { search: { similar } },
    );

    expect(result.isError).not.toBe(true);
    expect(similar).toHaveBeenCalledWith({
      pair: "expense_to_product",
      sourceId: EXPENSE_A,
      limit: 3,
    });
  });

  it("rejects a combination outside the allowlist before reaching the router", async () => {
    const similar = vi.fn();

    const result = await callTool(
      createMcpServer(),
      "find_similar_entities",
      { pair: "expense_to_recipe", sourceId: EXPENSE_A },
      { search: { similar } },
    );

    expect(result.isError).toBe(true);
    expect(similar).not.toHaveBeenCalled();
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

describe("household tracker synthesis + bulk tools", () => {
  const PROJECT_A = "44444444-4444-4444-8444-444444444441";
  const PROJECT_B = "44444444-4444-4444-8444-444444444442";
  const PROJECT_C = "44444444-4444-4444-8444-444444444443";
  const TASK_A = "55555555-5555-4555-8555-555555555551";
  const EXPENSE_A = "66666666-6666-4666-8666-666666666661";

  it("get_house_status passes filters through and trims UI-only + heavy fields", async () => {
    const project = mock(projectOut, {
      seed: 1,
      overrides: {
        id: PROJECT_A,
        name: "Kitchen",
        status: "in_progress",
        notes: "# a long markdown page body",
        icon: "🔨",
        googleDriveFolderUrl: "https://drive.google.com/drive/folders/kitchen",
        notionPageUrl: "https://cubby.notion.site/Kitchen-0123456789abcdef",
      },
    });
    const task = mock(taskOut, {
      seed: 2,
      overrides: {
        id: TASK_A,
        name: "Order countertop",
        status: "not_started",
      },
    });
    const summary = mock(projectDashboardSummaryOut, {
      seed: 3,
      overrides: {
        projects: [project],
        nextTasks: [task],
        attention: [
          {
            key: `overdue_task:${TASK_A}`,
            type: "overdue_task",
            severity: "critical",
            description: "Order countertop is 4 days overdue",
            entityType: "task",
            entityId: TASK_A,
            date: "2026-07-22",
            amount: null,
            href: "/tasks",
          },
        ],
      },
    });
    const dashboardSummary = vi.fn().mockResolvedValue(summary);

    const result = await callTool(
      createMcpServer(),
      "get_house_status",
      { statusScope: ["in_progress"] },
      { project: { dashboardSummary } },
    );

    expect(result.isError).not.toBe(true);
    expect(dashboardSummary).toHaveBeenCalledWith({
      statusScope: ["in_progress"],
    });
    const structured = result.structuredContent as {
      projects: Array<Record<string, unknown>>;
      nextTasks: Array<Record<string, unknown>>;
      attention: Array<{ type: string }>;
      filterOptions?: unknown;
    };
    // UI-only select options are dropped; the attention feed is the payload.
    expect(structured.filterOptions).toBeUndefined();
    expect(structured.attention[0]?.type).toBe("overdue_task");
    // Heavy per-row fields are trimmed, the rollup (budget/progress) is kept.
    expect(structured.projects[0]).toMatchObject({
      id: PROJECT_A,
      name: "Kitchen",
    });
    expect(structured.projects[0]).not.toHaveProperty("notes");
    expect(structured.projects[0]).not.toHaveProperty("googleDriveFolderUrl");
    expect(structured.projects[0]).not.toHaveProperty("notionPageUrl");
    expect(structured.projects[0]).not.toHaveProperty("blockedByIds");
    expect(structured.projects[0]).not.toHaveProperty("createdAt");
    expect(structured.projects[0]?.rollup).toBeDefined();
    expect(Object.keys(structured.nextTasks[0] ?? {}).sort()).toEqual([
      "dueDate",
      "dueEndDate",
      "id",
      "name",
      "projectId",
      "projectName",
      "status",
      "subjectProductId",
      "subjectProductName",
      "trade",
    ]);
  });

  it("match_expenses applies schema defaults, passes rows through, and preserves candidate order", async () => {
    const candidate = (
      overrides: Partial<ExpenseMatchCandidate>,
    ): ExpenseMatchCandidate => ({
      expenseId: unsafeExpenseId(EXPENSE_A),
      name: "dust extractor",
      cost: 599,
      date: "2024-06-10",
      future: false,
      notes: null,
      vendorName: null,
      orderId: null,
      projectName: null,
      productName: null,
      matchedOn: "amount_date",
      dayDelta: 0,
      amountDelta: 0,
      ratio: 1,
      ratioLabel: "exact",
      tokenOverlap: 0,
      ...overrides,
    });

    const ordered = [
      candidate({ matchedOn: "order_id", orderId: "1121197219" }),
      candidate({
        expenseId: unsafeExpenseId(PROJECT_B),
        name: "coincidence",
        matchedOn: "amount_date",
      }),
    ];
    const match = vi.fn().mockResolvedValue({
      matches: [{ key: "export-1", candidates: ordered }],
      unmatched: ["export-2"],
      summary: { rowsIn: 2, rowsWithCandidates: 1, exactOrderIdHits: 1 },
    });

    const result = await callTool(
      createMcpServer(),
      "match_expenses",
      {
        rows: [
          {
            key: "export-1",
            date: "2024-06-10",
            amount: 599,
            label: "Festool Vacuum",
          },
          { key: "export-2", date: "2024-06-10", amount: 1 },
        ],
      },
      { expense: { match } },
    );

    expect(result.isError).not.toBe(true);
    // Every tuning knob has a schema default, so a caller passing only `rows`
    // still reaches the repo with a fully-resolved option set.
    expect(match).toHaveBeenCalledWith(
      expect.objectContaining({
        dayWindow: 30,
        amountToleranceLow: 0.1,
        amountToleranceHigh: 0.15,
        amountFloor: 1,
        taxRate: 0.08625,
        maxCandidatesPerRow: 10,
      }),
    );
    expect(match.mock.calls[0]?.[0]?.rows).toHaveLength(2);

    const structured = result.structuredContent as {
      matches: Array<{ key: string; candidates: Array<{ matchedOn: string }> }>;
      unmatched: string[];
      summary: Record<string, number>;
    };
    // The repo already ranked these; the tool must not re-sort or trim them.
    expect(structured.matches[0]?.key).toBe("export-1");
    expect(structured.matches[0]?.candidates.map((c) => c.matchedOn)).toEqual([
      "order_id",
      "amount_date",
    ]);
    expect(structured.unmatched).toEqual(["export-2"]);
    expect(structured.summary.exactOrderIdHits).toBe(1);
  });

  it("match_expenses rejects a batch over the row cap rather than silently truncating", async () => {
    const match = vi.fn();
    const result = await callTool(
      createMcpServer(),
      "match_expenses",
      {
        rows: Array.from({ length: MATCH_MAX_ROWS + 1 }, (_, i) => ({
          key: `k${i}`,
          date: "2026-01-01",
          amount: 10,
        })),
      },
      { expense: { match } },
    );

    expect(result.isError).toBe(true);
    expect(match).not.toHaveBeenCalled();
  });

  it("get_project_budget derives overrun fields, sorts worst-first, and totals", async () => {
    const portfolioAnalytics = vi.fn().mockResolvedValue({
      costVsEstimate: [
        {
          projectId: PROJECT_B,
          projectName: "Garden",
          actual: 100,
          committed: 0,
          estimate: 500,
        },
        {
          projectId: PROJECT_C,
          projectName: "Garage",
          actual: 50,
          committed: 0,
          estimate: null,
        },
        {
          projectId: PROJECT_A,
          projectName: "Kitchen",
          actual: 1000,
          committed: 200,
          estimate: 1000,
        },
      ],
      spendingByProject: [],
      monthlySpend: [],
      plannedVsActual: [{ month: "2026-01", planned: 10, actual: 5 }],
      tradeActivity: [],
      taskHeatmap: [],
    });

    const result = await callTool(
      createMcpServer(),
      "get_project_budget",
      {},
      { project: { portfolioAnalytics } },
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      projects: Array<Record<string, unknown>>;
      totals: Record<string, number>;
      plannedVsActualByMonth: unknown;
    };
    // Worst overrun first; the unbudgeted project sinks to the bottom.
    expect(structured.projects.map((p) => p.projectName)).toEqual([
      "Kitchen",
      "Garden",
      "Garage",
    ]);
    expect(structured.projects[0]).toMatchObject({
      projected: 1200,
      remaining: -200,
      percentUsed: 120,
      overBudget: true,
    });
    expect(structured.projects[1]).toMatchObject({
      remaining: 400,
      percentUsed: 20,
      overBudget: false,
    });
    expect(structured.projects[2]).toMatchObject({
      remaining: null,
      percentUsed: null,
      overBudget: false,
    });
    expect(structured.totals).toEqual({
      estimate: 1500,
      actual: 1150,
      committed: 200,
      projected: 1350,
      overBudgetCount: 1,
      missingEstimateCount: 1,
    });
    expect(structured.plannedVsActualByMonth).toEqual([
      { month: "2026-01", planned: 10, actual: 5 },
    ]);
  });

  it("bulk task writes drop sideEffects and report an updated count", async () => {
    const updated = mock(taskOut, {
      seed: 4,
      overrides: { id: TASK_A, status: "done" },
    });
    const bulkSetStatus = vi.fn().mockResolvedValue({
      items: [updated],
      sideEffects: { backgroundBatches: ["batch-1"] },
    });

    const result = await callTool(
      createMcpServer(),
      "bulk_set_task_status",
      { ids: [TASK_A], status: "done" },
      { task: { bulkSetStatus } },
    );

    expect(bulkSetStatus).toHaveBeenCalledWith({
      ids: [TASK_A],
      status: "done",
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      updated: number;
      items: Array<Record<string, unknown>>;
    };
    expect(structured.updated).toBe(1);
    expect(structured.items[0]?.id).toBe(TASK_A);
    expect(result.structuredContent).not.toHaveProperty("sideEffects");
  });

  it("bulk expense writes drop sideEffects and report an updated count", async () => {
    const updated = mock(expenseOut, {
      seed: 5,
      overrides: { id: EXPENSE_A, projectId: PROJECT_A },
    });
    const bulkMove = vi.fn().mockResolvedValue({
      items: [updated],
      sideEffects: { backgroundBatches: ["batch-2"] },
    });

    const result = await callTool(
      createMcpServer(),
      "bulk_move_expenses",
      { ids: [EXPENSE_A], projectId: PROJECT_A },
      { expense: { bulkMove } },
    );

    expect(bulkMove).toHaveBeenCalledWith({
      ids: [EXPENSE_A],
      projectId: PROJECT_A,
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      updated: number;
      items: Array<Record<string, unknown>>;
    };
    expect(structured.updated).toBe(1);
    expect(structured.items[0]?.id).toBe(EXPENSE_A);
    expect(result.structuredContent).not.toHaveProperty("sideEffects");
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

describe("MCP Apps ui:// metadata", () => {
  // Regression: installMockStrippedListToolsHandler replaces the SDK's
  // tools/list handler and rebuilds each definition by hand. It used to omit
  // `_meta`, which is exactly where `ui.resourceUri` lives — so a host would
  // never learn the tool had a UI and would silently render text instead. There
  // is no error anywhere in that path, which is why this is guarded.
  it("survives the hand-rolled tools/list handler", async () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerMcpTool(server, {
      name: "ui_tool",
      description: "renders an app",
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: { readOnlyHint: true },
      uiResourceUri: "ui://cubby/test.html",
      handler: async () => ({ ok: true }),
    });
    installMockStrippedListToolsHandler(server);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const { tools } = await client.listTools();
      const meta = tools.find((t) => t.name === "ui_tool")?._meta;
      expect(meta?.ui).toEqual({ resourceUri: "ui://cubby/test.html" });
      // The deprecated flat alias ships too, for hosts that only read that one.
      expect(meta?.["ui/resourceUri"]).toBe("ui://cubby/test.html");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("points the UI tools at registered ui:// resources", async () => {
    const { tools } = await listMcpToolCatalog();
    const declared = new Set(
      tools
        .map((tool) => tool._meta?.ui as { resourceUri?: string } | undefined)
        .map((ui) => ui?.resourceUri)
        .filter((uri): uri is string => uri !== undefined),
    );
    expect([...declared].sort()).toEqual(
      [SHOPPING_LIST_UI, USDA_PICKER_UI].sort(),
    );

    // Every declared pointer must resolve, or the host fetches a 404 and the
    // tool renders nothing.
    const resources = await listMcpResourceCatalog();
    const served = new Set(resources.resources.map((r) => r.uri));
    for (const uri of declared) {
      expect(served.has(uri)).toBe(true);
    }
  });

  it("serves each app over resources/read, ready to render", async () => {
    // The end of the chain nothing else covered: `resources/list` proving a
    // pointer resolves says nothing about what `resources/read` actually
    // returns. A host fetches this exact payload and renders it, so assert the
    // three things that decide whether it renders at all — the MCP Apps mime
    // type, a self-contained document, and a substituted origin. The last one
    // is what silently broke deep links once already.
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const { resources } = await client.listResources();
      expect(resources.length).toBeGreaterThan(0);

      for (const resource of resources) {
        const { contents } = await client.readResource({ uri: resource.uri });
        const [content] = contents;
        expect(content?.mimeType).toBe("text/html;profile=mcp-app");
        // The contents union is text-or-blob; an app must be the text arm.
        expect(content && "text" in content).toBe(true);

        const html = (content as { text: string }).text;
        expect(html.startsWith("<!doctype html>")).toBe(true);
        // Self-contained: a sandboxed iframe has no origin to fetch from.
        expect(html).not.toMatch(/<script[^>]+src=/);
        expect(html).not.toMatch(/<link[^>]+href=/);
        // Substituted, and only in the meta tag.
        expect(html).not.toContain('content="__CUBBY_ORIGIN__"');
        expect(html).toMatch(
          /<meta name="cubby-origin" content="https?:\/\/[^"]+"/,
        );
      }
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("keeps the UI additive — the data is still on the wire without a host", async () => {
    // A host with no MCP Apps support ignores `_meta.ui` entirely, so these
    // tools must stay fully usable as plain structured-output tools.
    const { tools } = await listMcpToolCatalog();
    for (const name of ["get_shopping_list", "search_usda_foods"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.outputSchema).toBeDefined();
    }
  });
});

describe("registerMcpTool non-object output schemas", () => {
  // Regression: the SDK's validateToolOutput runs normalizeObjectSchema on the
  // registered outputSchema, which yields `undefined` for anything not
  // object-shaped, then parses against it — "Cannot read properties of
  // undefined (reading '_zod')". A union output therefore didn't degrade the
  // tool, it broke every call. `list_problems` was the only such tool and had
  // been failing outright since it gained a structured schema.
  const unionOut = z.union([
    z.object({ total: z.number() }),
    z.object({ type: z.string(), items: z.array(z.unknown()) }),
  ]);

  const serverWithUnionTool = (payload: unknown) => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerMcpTool(server, {
      name: "union_out",
      description: "returns one of two shapes",
      outputSchema: unionOut,
      annotations: { readOnlyHint: true },
      handler: async () => payload,
    });
    return server;
  };

  it("calls through for each branch of a union output", async () => {
    for (const payload of [
      { total: 3 },
      { type: "orphanedProducts", items: [{ id: "p1" }] },
    ]) {
      const result = (await callTool(
        serverWithUnionTool(payload),
        "union_out",
        {},
        {},
      )) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(payload);
    }
  });

  it("still enforces the precise schema, which the SDK stand-in cannot", async () => {
    // The permissive object handed to the SDK must not become the real check:
    // structuredSuccess parses the union itself, so a bad payload still errors.
    const result = (await callTool(
      serverWithUnionTool({ total: "not-a-number" }),
      "union_out",
      {},
      {},
    )) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});
