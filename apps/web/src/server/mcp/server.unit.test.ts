import { readFileSync } from "node:fs";
import type { Entity } from "@cubby/schemas/entity";
import { previewOperationInputSchema } from "@cubby/schemas/entity-integrity";
import {
  allEntities,
  entityManifest,
  mcpEntityPlural,
  mcpToolName,
} from "@cubby/schemas/entity-manifest";
import { FINANCIAL_STATEMENT_IMPORT_MAX_ROWS } from "@cubby/schemas/financial-transaction";
import { unsafeExpenseShortcode } from "@cubby/schemas/identifiers";
import { problemsCountSchema } from "@cubby/schemas/mcp";
import { mcpProductCreateInput } from "@cubby/schemas/product";
import { productComponentOut } from "@cubby/schemas/product-components";
import type { ExpenseMatchCandidate } from "@cubby/schemas/project";
import {
  expenseOut,
  MATCH_MAX_ROWS,
  projectDashboardSummaryOut,
  projectOut,
  projectResourceOut,
  taskOut,
} from "@cubby/schemas/project";
import { purchaseOut, purchaseProductOut } from "@cubby/schemas/purchase";
import { mcpRecipeCreateInput, recipeMcpOut } from "@cubby/schemas/recipe";
import type {
  McpTelemetryIdentity,
  TelemetryMessageV1,
} from "@cubby/schemas/telemetry";
import { vendorOut } from "@cubby/schemas/vendor";
import { SHORTCODE_PREFIX } from "@cubby/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mock } from "~/lib/test/mock-schema";
import { appRouter } from "~/server/api/root";
import { SHOPPING_LIST_UI, USDA_PICKER_UI } from "./apps";
import {
  createMcpServer,
  listMcpResourceCatalog,
  listMcpToolCatalog,
  MCP_SERVER_INSTRUCTIONS,
  slimMeal,
  slimProduct,
  slimProductDetail,
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
  WRITE_DESTRUCTIVE_CLOSED,
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
  telemetry?: {
    identity: McpTelemetryIdentity;
    emit: (event: TelemetryMessageV1) => Promise<void>;
  },
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  const originalSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    originalSend(message, {
      ...options,
      authInfo: {
        token: "",
        clientId: "test",
        scopes: [],
        extra: { caller, telemetry },
      },
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

type Operation = "list" | "get" | "create" | "update" | "delete";

describe("list_problems focused routing", () => {
  it("uses only the count procedure for countsOnly", async () => {
    const getCounts = vi.fn(async () => mock(problemsCountSchema));
    const getByType = vi.fn();

    await callTool(
      createMcpServer(),
      "list_problems",
      { countsOnly: true },
      {
        problems: { getCounts, getByType },
      },
    );

    expect(getCounts).toHaveBeenCalledOnce();
    expect(getByType).not.toHaveBeenCalled();
  });

  it("uses only the owning procedure for a single type", async () => {
    const getCounts = vi.fn();
    const getByType = vi.fn(async () => ({
      type: "orphanedProducts",
      items: [],
      total: 0,
    }));

    await callTool(
      createMcpServer(),
      "list_problems",
      { type: "orphanedProducts" },
      { problems: { getCounts, getByType } },
    );

    expect(getByType).toHaveBeenCalledOnce();
    expect(getByType).toHaveBeenCalledWith({
      key: "orphanedProducts",
    });
    expect(getCounts).not.toHaveBeenCalled();
  });
});

describe("MCP tool-call telemetry", () => {
  const identity = {
    userId: "user_1",
    clientId: "oauth-client-1",
    surface: "external_mcp" as const,
  };

  it("captures a successful call without arguments or output", async () => {
    const emit = vi.fn(async (_event: TelemetryMessageV1) => undefined);
    await callTool(
      createMcpServer(),
      "list_locations",
      {},
      {
        location: {
          list: async () => ({
            meta: { pageIndex: 0, pageSize: 200, totalCount: 0 },
            items: [],
          }),
        },
      },
      { identity, emit },
    );

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mcp_tool_call",
        toolName: "list_locations",
        outcome: "success",
        registeredAtCall: true,
        ...identity,
      }),
    );
    expect(Object.keys(emit.mock.calls[0]?.[0] ?? {})).not.toEqual(
      expect.arrayContaining(["arguments", "output", "errorText", "sessionId"]),
    );
  });

  it("captures handler and validation errors", async () => {
    const handlerEmit = vi.fn(async (_event: TelemetryMessageV1) => undefined);
    await callTool(
      createMcpServer(),
      "list_locations",
      {},
      { location: { list: vi.fn().mockRejectedValue(new Error("failed")) } },
      { identity, emit: handlerEmit },
    );
    expect(handlerEmit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", toolName: "list_locations" }),
    );

    const validationEmit = vi.fn(
      async (_event: TelemetryMessageV1) => undefined,
    );
    await callTool(
      createMcpServer(),
      "list_expenses",
      { costPresenceFilter: "sometimes" },
      { expense: { list: vi.fn() } },
      { identity, emit: validationEmit },
    );
    expect(validationEmit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "error", toolName: "list_expenses" }),
    );
  });

  it("captures a named unknown tool as retired/unregistered evidence", async () => {
    const emit = vi.fn(async (_event: TelemetryMessageV1) => undefined);

    await callTool(
      createMcpServer(),
      "removed_tool",
      {},
      {},
      { identity, emit },
    ).catch(() => undefined);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        toolName: "removed_tool",
        registeredAtCall: false,
      }),
    );
  });
});

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
      // A real registry entity: `entity` now names the shortcode prefix, so a
      // made-up slug can no longer stand in for one.
      entity: "vendor",
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
    // The CRUD toolset's router key is the entity itself ("vendor"), not the
    // overridden tool name ("search_widgets") — only the tool's public name
    // changed via `names.list`.
    await callTool(server, "search_widgets", {}, { vendor: { list } });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        pagination: { pageIndex: 0, pageSize: 7 },
      }),
    );
    expect(getRegisteredTool(server, "get_vendor")?.outputSchema).toBe(
      detailOut,
    );
    expect(getRegisteredTool(server, "create_vendor")?.outputSchema).toBe(
      mutationOut,
    );
    expect(getRegisteredTool(server, "update_vendor")?.outputSchema).toBe(
      mutationOut,
    );
    expect(getRegisteredTool(server, "delete_vendors")).toBeUndefined();
  });

  it("registers bounded best-effort batches with valid all-failed results", async () => {
    const server = new McpServer({ name: "t", version: "1.0.0" });
    const mutationOut = z.object({ id: z.string(), changed: z.boolean() });
    // No `batch:` here on purpose — batching is the DEFAULT, so a toolset that
    // says nothing about it still gets the plural tools.
    registerEntityCrudToolset(server, {
      entity: "vendor",
      createInput: { name: z.string() },
      updateShape: { name: z.string().optional() },
      filterFields: {},
      mcpListOut: z.object({ items: z.array(z.object({ id: z.string() })) }),
      out: mutationOut,
      sort: { orderBy: "name" },
      slim: (value) => value as Record<string, unknown>,
      descriptions: {
        list: "list",
        get: "get",
        create: "create",
        update: "update",
        delete: "delete",
      },
    });

    expect(getRegisteredTool(server, "create_vendors")).toBeDefined();
    expect(getRegisteredTool(server, "update_vendors")).toBeDefined();

    const create = vi.fn().mockRejectedValue(new Error("vendor write failed"));
    const allFailed = await callTool(
      server,
      "create_vendors",
      { items: [{ name: "one" }, { name: "two" }] },
      { vendor: { create } },
    );
    expect(allFailed.isError).not.toBe(true);
    expect(allFailed.structuredContent).toMatchObject({
      summary: { requested: 2, succeeded: 0, failed: 2 },
      results: [
        { index: 0, status: "failed", error: "vendor write failed" },
        { index: 1, status: "failed", error: "vendor write failed" },
      ],
    });

    const tooMany = await callTool(
      server,
      "create_vendors",
      {
        items: Array.from({ length: 51 }, (_, index) => ({ name: `${index}` })),
      },
      { vendor: { create } },
    );
    expect(tooMany.isError).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed batch item from rolling back its siblings", async () => {
    // The whole point of the best-effort contract: 25 good locations must not
    // be discarded because the 26th collided with an existing name. Each item
    // runs the singular operation in its OWN transaction, so this is a property
    // of the loop, not something the caller has to opt into.
    const server = new McpServer({ name: "t", version: "1.0.0" });
    const mutationOut = z.object({ id: z.string(), name: z.string() });
    registerEntityCrudToolset(server, {
      entity: "vendor",
      createInput: { name: z.string() },
      updateShape: { name: z.string().optional() },
      filterFields: {},
      mcpListOut: z.object({ items: z.array(z.object({ id: z.string() })) }),
      out: mutationOut,
      sort: { orderBy: "name" },
      slim: (value) => value as Record<string, unknown>,
      descriptions: {
        list: "list",
        get: "get",
        create: "create",
        update: "update",
        delete: "delete",
      },
    });

    const create = vi.fn(async (input: { name: string }) => {
      if (input.name === "dupe") throw new Error("CONFLICT: already exists");
      return { id: `v-${input.name}`, name: input.name };
    });
    const partial = await callTool(
      server,
      "create_vendors",
      { items: [{ name: "one" }, { name: "dupe" }, { name: "three" }] },
      { vendor: { create } },
    );

    expect(partial.isError).not.toBe(true);
    expect(partial.structuredContent).toMatchObject({
      summary: { requested: 3, succeeded: 2, failed: 1 },
      results: [
        { index: 0, status: "succeeded", id: "v-one" },
        { index: 1, status: "failed", error: "CONFLICT: already exists" },
        { index: 2, status: "succeeded", id: "v-three" },
      ],
    });
    // The item AFTER the failure still ran — a failure is not a stop condition.
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("returns compact results by default and whole entities on request", async () => {
    // A 21-item create_purchases returned 58,603 characters, because every
    // succeeded item echoed the full singular output. The caller of a 50-item
    // write almost always wants the 50 shortcodes, so that is the default now
    // and the hydrated entity is the opt-in.
    const server = new McpServer({ name: "t", version: "1.0.0" });
    registerEntityCrudToolset(server, {
      entity: "vendor",
      createInput: { name: z.string() },
      updateShape: { name: z.string().optional() },
      filterFields: {},
      mcpListOut: z.object({ items: z.array(z.object({ id: z.string() })) }),
      out: z.object({ id: z.string(), name: z.string() }),
      sort: { orderBy: "name" },
      slim: (value) => value as Record<string, unknown>,
      descriptions: {
        list: "list",
        get: "get",
        create: "create",
        update: "update",
        delete: "delete",
      },
    });

    const create = vi.fn(async (input: { name: string }) => ({
      id: `v-${input.name}`,
      name: input.name,
    }));
    const compact = await callTool(
      server,
      "create_vendors",
      { items: [{ name: "one" }] },
      { vendor: { create } },
    );
    expect(
      (compact.structuredContent as { results: unknown[] }).results,
    ).toEqual([{ index: 0, status: "succeeded", id: "v-one" }]);

    const full = await callTool(
      server,
      "create_vendors",
      { items: [{ name: "one" }], resultDetail: "full" },
      { vendor: { create } },
    );
    expect((full.structuredContent as { results: unknown[] }).results).toEqual([
      { index: 0, status: "succeeded", item: { id: "v-one", name: "one" } },
    ]);
  });

  it("renames batch tools through names.batchCreate/batchUpdate", async () => {
    // `${entityPlural}` is wrong for an entity whose singular tools were already
    // renamed: inventory's rows are "entries", so the derived names would be
    // `create_inventorys`. The override is what keeps those readable.
    const server = new McpServer({ name: "t", version: "1.0.0" });
    registerEntityCrudToolset(server, {
      entity: "vendor",
      names: { batchCreate: "create_widgets", batchUpdate: "update_widgets" },
      createInput: { name: z.string() },
      updateShape: { name: z.string().optional() },
      filterFields: {},
      mcpListOut: z.object({ items: z.array(z.object({ id: z.string() })) }),
      out: z.object({ id: z.string() }),
      sort: { orderBy: "name" },
      slim: (value) => value as Record<string, unknown>,
      descriptions: {
        list: "list",
        get: "get",
        create: "create",
        update: "update",
        delete: "delete",
      },
    });

    expect(getRegisteredTool(server, "create_widgets")).toBeDefined();
    expect(getRegisteredTool(server, "update_widgets")).toBeDefined();
    expect(getRegisteredTool(server, "create_vendors")).toBeUndefined();
    expect(getRegisteredTool(server, "update_vendors")).toBeUndefined();
  });

  it("omits a batch tool when its singular operation is disabled", async () => {
    const server = new McpServer({ name: "t", version: "1.0.0" });
    registerEntityCrudToolset(server, {
      entity: "vendor",
      createInput: { name: z.string() },
      updateShape: { name: z.string().optional() },
      filterFields: {},
      mcpListOut: z.object({ items: z.array(z.object({ id: z.string() })) }),
      out: z.object({ id: z.string() }),
      sort: { orderBy: "name" },
      operations: { create: false, delete: false },
      slim: (value) => value as Record<string, unknown>,
      descriptions: {
        list: "list",
        get: "get",
        create: "create",
        update: "update",
      },
    });

    // No `create_vendor` means no router method to batch over.
    expect(getRegisteredTool(server, "create_vendors")).toBeUndefined();
    expect(getRegisteredTool(server, "update_vendors")).toBeDefined();
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

describe("slimProduct enrichment context", () => {
  it("reports identity fields and no cover for a product without images", () => {
    const slim = slimProduct({
      id: "PRD-ABCD",
      name: "M18 framing nailer",
      manufacturer: "Milwaukee",
      model: "2744-20",
      notes: "Bare tool",
      images: [],
    });

    expect(slim).toMatchObject({
      model: "2744-20",
      notes: "Bare tool",
      imageCount: 0,
      coverImageUrl: null,
    });
  });

  it("uses the first displayable image as cover and excludes PDF manuals", () => {
    const slim = slimProduct({
      id: "PRD-EFGH",
      name: "Track saw",
      manufacturer: "Festool",
      images: [
        {
          url: "https://images.example.test/manual.pdf",
          contentType: "application/pdf",
        },
        {
          url: "https://images.example.test/cover.webp",
          contentType: "image/webp",
        },
        {
          url: "https://images.example.test/alternate.jpg",
          contentType: "image/jpeg",
        },
      ],
    });

    expect(slim.imageCount).toBe(2);
    expect(slim.coverImageUrl).toBe("https://images.example.test/cover.webp");
  });

  it("details every file while excluding failed integrity from cover positions", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const file = (
      id: string,
      contentType: string,
      storageStatus: string | null,
    ) => ({
      id,
      url: `https://images.example.test/${id}`,
      key: `products/${id}`,
      filename: id,
      size: 100,
      contentType,
      status: "UPLOADED",
      width: contentType === "application/pdf" ? null : 100,
      height: contentType === "application/pdf" ? null : 100,
      detectedContentType: contentType,
      sha256: "a".repeat(64),
      renderStatus: storageStatus === "missing" ? "failed" : "verified",
      storageStatus,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const detail = slimProductDetail({
      id: "PRD-EFGH",
      name: "Track saw",
      manufacturer: "Festool",
      images: [
        file(
          "11111111-1111-1111-1111-111111111111",
          "application/pdf",
          "available",
        ),
        file("22222222-2222-2222-2222-222222222222", "image/webp", "missing"),
        file("33333333-3333-3333-3333-333333333333", "image/jpeg", "available"),
      ],
    });

    expect(detail.coverImageId).toBe("33333333-3333-3333-3333-333333333333");
    expect(detail.imageCount).toBe(1);
    expect(detail.images.map((image) => image.displayPosition)).toEqual([
      null,
      null,
      1,
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
          // mealRecipe row id — declared exception, no shortcode; stays uuid.
          id: "mr-1",
          recipeId: "RCP-2222",
          recipe: {
            id: "RCP-2222",
            name: "Chili",
            sections: [{ huge: true }],
          },
          scale: 2,
          sortOrder: 0,
          scaledTotals: { costTotal: 12, caloriesTotal: 800 },
        },
      ],
    });
    expect(slim.recipes).toEqual([
      {
        id: "mr-1",
        recipeId: "RCP-2222",
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
      linkedProducts: [{ id: "PRD-2222", name: "salt", notes: "drop me" }],
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
      linkedProducts: [{ id: "PRD-2222", name: "salt" }],
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

  it("advertises the deployed Git commit as its development build id", async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createMcpServer();
    const client = new Client({ name: "test", version: "1.0.0" });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      expect(client.getServerVersion()?.version).toBe(`dev-${__GIT_COMMIT__}`);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
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
  it("exposes reusable-resource operations and retires tool-only aliases", async () => {
    const names = new Set(
      (await listMcpToolCatalog()).tools.map((tool) => tool.name),
    );
    for (const name of [
      "list_project_resources",
      "list_product_project_uses",
      "suggest_project_tools",
      "list_purchase_products",
      "list_product_components",
      // The three relation families share one pair of tools; the parent's
      // shortcode prefix picks the family. `list_*` stays per-family because
      // its OUTPUT shape genuinely differs.
      "attach_entity",
      "detach_entity",
    ]) {
      expect(names.has(name), `${name} missing from catalog`).toBe(true);
    }
    for (const name of [
      "list_project_tools",
      "attach_project_tools",
      "detach_project_tools",
      // Replaced by attach_entity/detach_entity, not renamed.
      "attach_project_resources",
      "detach_project_resources",
      "attach_purchase_products",
      "detach_purchase_products",
      "attach_product_components",
      "detach_product_components",
    ]) {
      expect(names.has(name), `${name} unexpectedly remains in catalog`).toBe(
        false,
      );
    }
  });

  it("exposes generic batches and retires redundant MCP wrappers", async () => {
    const names = new Set(
      (await listMcpToolCatalog()).tools.map((tool) => tool.name),
    );
    for (const name of [
      "create_products",
      "update_products",
      "create_expenses",
      "update_expenses",
      "create_purchases",
      "update_purchases",
      "update_tasks",
      "create_financial_transactions",
      "update_financial_transactions",
      "find_or_create_product_by_upc",
      "move_inventory_entries",
    ]) {
      expect(names.has(name), `${name} missing from catalog`).toBe(true);
    }
    for (const name of [
      "get_meals_by_date_range",
      "update_product_unit_mappings",
      "bulk_set_task_status",
      "bulk_move_tasks",
      // The last `bulk_*` tool, retired for the same reason as the others: it
      // named a narrower operation than the work. `move_inventory_entries` is a
      // strict superset (per-item target, derivable source, optional quantity).
      "bulk_move_inventory",
      "bulk_set_task_due_date",
      "bulk_move_expenses",
      "bulk_set_expense_trade",
      "bulk_set_expense_cost_type",
      "get_ingredient_raw_lines",
      "recompute_recipe_totals",
      "reparse_stale_parses",
      "find_duplicate_inventory",
      "find_product_by_upc",
    ]) {
      expect(names.has(name), `${name} unexpectedly remains in catalog`).toBe(
        false,
      );
    }
  });

  it("keeps the purchase-import skill aligned with the completeness catalog", async () => {
    const { tools } = await listMcpToolCatalog();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "set_data_exception",
      "clear_data_exception",
      "reclassify_purchase_document",
      "find_product_external_id_collisions",
      "patch_product_external_ids",
      "verify_product_images",
    ]) {
      expect(byName.has(name), `${name} missing from catalog`).toBe(true);
    }

    const purchaseFilters = byName.get("list_purchases")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(purchaseFilters.properties).toHaveProperty("dataStatus");
    expect(purchaseFilters.properties).toHaveProperty("dataGap");
    const productFilters = byName.get("search_products")?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(productFilters.properties).toHaveProperty("modelPresenceFilter");
    expect(productFilters.properties).toHaveProperty("externalIdSource");
    expect(productFilters.properties).toHaveProperty(
      "externalIdPresenceFilter",
    );
    expect(productFilters.properties).toHaveProperty("sort");
    const attachFile = byName.get("attach_file");
    expect(attachFile).toBeDefined();
    expect(
      (
        attachFile!.inputSchema as {
          properties?: Record<string, unknown>;
        }
      ).properties,
    ).toHaveProperty("documentKind");
    expect(
      (
        attachFile!.inputSchema as {
          properties?: Record<string, unknown>;
        }
      ).properties,
    ).toMatchObject({
      idempotencyKey: expect.any(Object),
      expectedImageCount: expect.any(Object),
    });

    const updateProduct = byName.get("update_product");
    expect(
      (
        updateProduct!.inputSchema as {
          properties?: Record<string, unknown>;
        }
      ).properties,
    ).toMatchObject({
      removeImageIds: expect.any(Object),
      imageOrder: expect.any(Object),
    });

    const skill = readFileSync(
      new URL(
        "../../../../../.claude/skills/purchase-import/SKILL.md",
        import.meta.url,
      ),
      "utf8",
    );
    for (const name of [
      "set_data_exception",
      "clear_data_exception",
      "reclassify_purchase_document",
      "find_product_external_id_collisions",
    ]) {
      expect(skill).toContain(name);
    }
  });

  it("keeps the product-enrichment skill aligned with hardened MCP tools", async () => {
    const { tools } = await listMcpToolCatalog();
    const names = new Set(tools.map((tool) => tool.name));
    const skill = readFileSync(
      new URL(
        "../../../../../.claude/skills/product-enrichment/SKILL.md",
        import.meta.url,
      ),
      "utf8",
    );
    for (const name of [
      "patch_product_external_ids",
      "find_product_external_id_collisions",
      "attach_file",
      "verify_product_images",
    ]) {
      expect(names.has(name), `${name} missing from catalog`).toBe(true);
      expect(skill).toContain(name);
    }
    expect(skill).toContain('sort: "identity_strength"');
    expect(skill).toContain("expectedImageCount");
    expect(skill).toContain("idempotencyKey");
  });

  it("advertises canonical purchase and expense terminology", async () => {
    const { tools } = await listMcpToolCatalog();
    const listPurchases = tools.find((tool) => tool.name === "list_purchases");
    expect(listPurchases).toBeDefined();
    const properties = (
      listPurchases?.inputSchema as
        | {
            properties?: Record<string, unknown>;
          }
        | undefined
    )?.properties;

    expect(properties).toHaveProperty("expenseStatus");
    expect(properties).toHaveProperty("expenseId");
    expect(properties).toHaveProperty("expensePresenceFilter");
    expect(properties).toHaveProperty("expenseSearch");
    expect(properties).toHaveProperty("financialTransactionId");
    expect(properties).toHaveProperty("financialTransactionPresenceFilter");
    expect(properties).toHaveProperty("financialTransactionSearch");
    expect(properties).toHaveProperty("productId");
    expect(properties).toHaveProperty("productPresenceFilter");
    expect(properties).toHaveProperty("productSearch");
    expect(properties).toHaveProperty("projectId");
    expect(properties).toHaveProperty("projectPresenceFilter");
    expect(properties).toHaveProperty("projectSearch");
    expect(properties).not.toHaveProperty("lineStatus");
    expect(listPurchases?.description).toContain("List vendor purchases");
    expect(listPurchases?.description).not.toMatch(/vendor charges/i);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('type="purchasesNotReconciling"');
    expect(MCP_SERVER_INSTRUCTIONS).not.toContain("chargesNotReconciling");
  });

  it("keeps manifest MCP operations aligned with registered tools", async () => {
    const catalog = new Set(
      (await listMcpToolCatalog()).tools.map(({ name }) => name),
    );

    // `delete` is deliberately absent: there is no per-entity delete tool any
    // more. One `delete_entity` takes the entity as a parameter, and its own
    // coverage is asserted separately below.
    const OPERATIONS: Operation[] = ["list", "get", "create", "update"];

    for (const entity of allEntities) {
      const declared = new Set<Operation>(entityManifest[entity].mcp);
      // Both directions: a declared op must be registered, and an UNDECLARED op
      // must not be. The negative half is what guards the deliberate omissions —
      // vendor/purchase have no delete tool on purpose (see the manifest), and
      // without this a stray registration would pass unnoticed.
      for (const operation of OPERATIONS) {
        // Derived from the manifest, not from a table kept beside this test.
        // The hand-kept copy could drift from the manifest silently; now the
        // manifest is the only source and this asserts it against the catalog.
        const toolName = mcpToolName(entity, operation);
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

  it("exposes one delete_entity covering exactly the delete-declaring entities", async () => {
    // The twelve `delete_<plural>` tools collapsed into one. The manifest is
    // still the source of truth for WHICH entities are deletable — vendor and
    // purchase omit "delete" on purpose (each has a narrower tool), and image
    // exposes no MCP tools at all — so the generic tool's `entity` enum must
    // match the manifest exactly, in both directions.
    const { tools } = await listMcpToolCatalog();
    const names = new Set(tools.map(({ name }) => name));
    expect(names.has("delete_entity")).toBe(true);

    const schema = tools.find((tool) => tool.name === "delete_entity")
      ?.inputSchema as
      | { properties?: { entity?: { enum?: string[] } } }
      | undefined;
    const covered = [...(schema?.properties?.entity?.enum ?? [])].sort();
    const expected = allEntities
      .filter((entity) =>
        (entityManifest[entity].mcp as readonly Operation[]).includes("delete"),
      )
      .sort();
    expect(covered).toEqual(expected);

    // No entity may have both routes.
    for (const entity of covered) {
      expect({
        entity,
        alsoHasPerEntityTool: names.has(
          mcpToolName(entity as Entity, "delete"),
        ),
      }).toEqual({ entity, alsoHasPerEntityTool: false });
    }
  });

  it("keeps resultDetail compact except where the entity is the point", async () => {
    // The default flip is only safe because it is per tool: a write batch hands
    // back ids, but `verify_products_images` exists to report what verification
    // found, and a list of ids would report nothing.
    const { tools } = await listMcpToolCatalog();
    const defaultOf = (name: string) => {
      const schema = tools.find((tool) => tool.name === name)?.inputSchema as
        | { properties?: Record<string, { default?: unknown }> }
        | undefined;
      return schema?.properties?.resultDetail?.default;
    };
    expect(defaultOf("create_purchases")).toBe("summary");
    expect(defaultOf("update_products")).toBe("summary");
    expect(defaultOf("attach_files")).toBe("full");
    expect(defaultOf("verify_products_images")).toBe("full");
  });

  it("gives every create/update entity a plural batch counterpart", async () => {
    // Batching is INHERENT, not opt-in. It used to be a per-toolset flag that
    // only five of fifteen toolsets ever set, which is how `delete_locations`
    // could exist while `create_location` stayed singular — plural delete comes
    // from a different mechanism and hid the gap. This asserts the invariant
    // directly, so flipping the default back, or quietly dropping one entity,
    // fails here rather than being discovered mid-reorganization.
    //
    // An entity that genuinely should not batch goes in BATCH_EXEMPT with a
    // reason, so the exemption is a visible decision rather than an omission.
    const BATCH_EXEMPT: Partial<
      Record<Entity, ReadonlyArray<"create" | "update">>
    > = {};

    const catalog = new Set(
      (await listMcpToolCatalog()).tools.map(({ name }) => name),
    );

    for (const entity of allEntities) {
      const plural = mcpEntityPlural(entity);
      const declared = new Set<Operation>(entityManifest[entity].mcp);
      for (const operation of ["create", "update"] as const) {
        const toolName = `${operation}_${plural}`;
        const expected =
          declared.has(operation) && !BATCH_EXEMPT[entity]?.includes(operation);
        expect({ entity, toolName, registered: catalog.has(toolName) }).toEqual(
          {
            entity,
            toolName,
            registered: expected,
          },
        );
      }
    }
  });

  it("keeps preview_entity_operation's per-operation rules after the flattening", () => {
    // The tool's input used to be a union of one object per {operation, entity}
    // pair, which is what made it uncallable. Flattening it moved every rule
    // those constructors gave for free into a single refine — this is the list
    // of what must NOT have been lost along the way. (Prefix coverage for the
    // shortcode/uuid split lives in entity-integrity.unit.test.ts.)
    const rejected: Array<[reason: string, input: unknown]> = [
      [
        "wrong prefix for the entity",
        { operation: "delete", entity: "product", ids: ["LOC-2CRC"] },
      ],
      ["delete without ids", { operation: "delete", entity: "product" }],
      [
        "delete carrying merge fields",
        {
          operation: "delete",
          entity: "product",
          ids: ["PRD-2CRC"],
          keepId: "PRD-2CRD",
        },
      ],
      [
        // `product` used to be the example here; it gained a merge in the same
        // change that added `mergeProducts`, so this needs an entity that still
        // has no merge planner. `location` is delete-only.
        "merge on an entity that cannot merge",
        { operation: "merge", entity: "location", mergeIds: ["LOC-2CRC"] },
      ],
      ["merge without mergeIds", { operation: "merge", entity: "ingredient" }],
      [
        "merge carrying delete fields",
        {
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC"],
          ids: ["ING-2CRD"],
        },
      ],
      [
        "repeated mergeIds",
        {
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC", "ING-2CRC"],
        },
      ],
      [
        "keepId also being merged away",
        {
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC"],
          keepId: "ING-2CRC",
        },
      ],
      [
        "more than 200 targets",
        {
          operation: "delete",
          entity: "product",
          ids: Array.from({ length: 201 }, () => "PRD-2CRC"),
        },
      ],
      [
        // The other half of the image cut-over: the uuid arm is gone, not
        // merely unused. Leaving it accepted would keep the hole open.
        "an image by raw uuid",
        {
          operation: "delete",
          entity: "image",
          ids: ["3f2504e0-4f89-41d3-9a0c-0305e82c3302"],
        },
      ],
    ];
    for (const [reason, input] of rejected) {
      expect({
        reason,
        accepted: previewOperationInputSchema.safeParse(input).success,
      }).toEqual({ reason, accepted: false });
    }

    const accepted: Array<[reason: string, input: unknown]> = [
      [
        "delete by shortcode",
        { operation: "delete", entity: "product", ids: ["PRD-2CRC"] },
      ],
      [
        // Images carry `IMG-` codes like every other entity now. This case used
        // to pass a raw uuid, which was the last place a uuid could enter the
        // MCP boundary — an `IMG-` code read off any response could not be fed
        // back into its own delete preview.
        "hard-delete an image by shortcode",
        {
          operation: "delete",
          entity: "image",
          ids: ["IMG-2CRC"],
        },
      ],
      [
        "merge candidates with no keeper yet",
        {
          operation: "merge",
          entity: "ingredient",
          mergeIds: ["ING-2CRC", "ING-2CRD"],
        },
      ],
      [
        "merge with a keeper",
        {
          operation: "merge",
          entity: "vendor",
          mergeIds: ["VEN-2CRC"],
          keepId: "VEN-2CRD",
        },
      ],
    ];
    for (const [reason, input] of accepted) {
      expect({
        reason,
        accepted: previewOperationInputSchema.safeParse(input).success,
      }).toEqual({ reason, accepted: true });
    }
  });

  it("delivers preview_entity_operation's arguments to the router", async () => {
    // Regression: this tool's input was a top-level `z.union`, which
    // `normalizeObjectSchema` turns into `undefined` — the SDK then parsed every
    // call against an EMPTY object and the handler received `{}`. The tool
    // advertised no arguments and could not be called at all.
    const args = {
      operation: "delete",
      entity: "product",
      ids: ["PRD-2222"],
    };
    let received: unknown;
    const result = await callTool(
      createMcpServer(),
      "preview_entity_operation",
      args,
      {
        entityIntegrity: {
          previewOperation: async (input: unknown) => {
            received = input;
            return {
              operation: "delete",
              entity: "product",
              mode: "soft",
              targetCount: 1,
              canProceed: true,
              blockers: [],
              changes: [],
              sideEffects: [],
              generatedAt: new Date().toISOString(),
            };
          },
        },
      },
    );

    expect(received).toEqual(args);
    expect(result.isError).not.toBe(true);
  });

  it("hands every entity get tool an argument its router's getByID accepts", async () => {
    // Regression: get_wish was uncallable from the day it shipped. The crud
    // toolset's default fetch calls `router.getByID({ id })`, but `wish.getByID`
    // then declared `.input(wishShortcode)` — a BARE scalar — so zod rejected
    // every call before the query ran. vendor and purchase carried hand-written
    // `get:` overrides for exactly this; wish simply didn't. All three have
    // since moved onto the crud factory, so `{ id }` is now the shape
    // everywhere and the shims are gone — which is precisely why this guard has
    // to stay: nothing in the catalog can see such a mismatch (the advertised
    // input is `{id}` either way), so it drives the real handler with a stub
    // caller and checks the argument it actually passes against the schema the
    // router actually declares.
    const procedures = (
      appRouter as unknown as {
        _def: { procedures: Record<string, { _def: { inputs: unknown[] } }> };
      }
    )._def.procedures;

    // Every entity with both a shortcode and a declared `get` tool. usda-food
    // and image are excluded because they have no shortcode (their get tools,
    // where present, are keyed by fdc_id / uuid, not by the `{ id }` default).
    const entities = allEntities.filter(
      (entity) =>
        Object.hasOwn(SHORTCODE_PREFIX, entity) &&
        (entityManifest[entity].mcp as readonly Operation[]).includes("get"),
    );
    expect(entities.length).toBeGreaterThanOrEqual(14);

    for (const entity of entities) {
      const prefix = SHORTCODE_PREFIX[entity as keyof typeof SHORTCODE_PREFIX];
      const toolName = mcpToolName(entity, "get");
      const procedure = procedures[`${entity}.getByID`];
      expect(procedure, `${entity}.getByID is missing`).toBeDefined();
      const declaredInput = procedure?._def.inputs[0] as z.ZodType | undefined;
      expect(
        declaredInput,
        `${entity}.getByID declares no input schema`,
      ).toBeDefined();

      let captured: unknown;
      await callTool(
        createMcpServer(),
        toolName,
        { id: `${prefix}2222` },
        {
          [entity]: {
            getByID: async (argument: unknown) => {
              captured = argument;
              return {};
            },
          },
        },
      );

      expect(
        captured,
        `${toolName} never reached ${entity}.getByID`,
      ).toBeDefined();
      expect({
        tool: toolName,
        accepted: declaredInput?.safeParse(captured).success,
      }).toEqual({ tool: toolName, accepted: true });
    }
  });

  it("carries every field create_product advertises through to product.create", async () => {
    // Regression: the MCP create handler copied `mcpProductCreateInput` across
    // field by field, so `stockTracked` — added to the shape later — never
    // reached the router. Twenty-one products created with an explicit
    // `stockTracked: false` read back `null`, which is a DIFFERENT fact: null
    // means "undecided, still on the Not-on-a-shelf worklist", false means
    // "reviewed, no shelf claim". Nothing in the catalog could see it, because
    // the tool advertised the field correctly and only dropped it downstream.
    // Asserted over the shape rather than one field name so the next field
    // added to the MCP shape is covered without touching this test.
    const args: Record<string, unknown> = {
      name: "Field Passthrough Product",
      manufacturer: "generic",
      aliases: ["passthrough alias"],
      tags: ["passthrough-tag"],
      upc: null,
      isbn: null,
      fdc_id: null,
      model: "MDL-1",
      notes: "passthrough notes",
      expectedQuantity: 2,
      category: "hardware",
      ingredientId: `${SHORTCODE_PREFIX.ingredient}2222`,
      price: 12.5,
      unitMappings: [
        { a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } },
      ],
      externalIds: [
        { source: "amazon", kind: "asin", externalId: "B000PASSTHRU" },
      ],
      usdaUnavailable: false,
      stockTracked: false,
    };
    expect(Object.keys(args).sort()).toEqual(
      Object.keys(mcpProductCreateInput.shape).sort(),
    );

    let captured: Record<string, unknown> | undefined;
    // The stub's return value is irrelevant here — output validation runs after
    // the capture, so a failed response still proves what the router received.
    await callTool(createMcpServer(), "create_product", args, {
      product: {
        create: async (argument: Record<string, unknown>) => {
          captured = argument;
          return {};
        },
      },
    });

    expect(
      captured,
      "create_product never reached product.create",
    ).toBeDefined();
    const dropped = Object.keys(mcpProductCreateInput.shape).filter(
      (field) => !(captured && field in captured),
    );
    expect(dropped).toEqual([]);
    // An explicit decision, not an absent one: `false` must not arrive as null.
    expect(captured?.stockTracked).toBe(false);
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
    // tools (get_house_status and other catalog entries) — those derived
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

    // An EMPTY `properties` is the other half of the same failure, and it is
    // the one that let two uncallable tools ship: `normalizeObjectSchema`
    // returns `undefined` for a non-object input schema, which used to be
    // silently swapped for `z.object({})` — advertising `{}` AND stripping
    // every argument before the handler ran (preview_entity_operation's
    // top-level `z.union`). `properties === undefined` never fires for that,
    // because `{type: "object", properties: {}}` is perfectly well-formed.
    // Registration now throws instead (see `toolInputSchema`); this is the
    // catalog-level backstop.
    const NO_ARGUMENT_TOOLS = new Set([
      "list_cookbooks",
      "get_recipe_tags",
      "list_actionable_tasks",
      "get_task_summary",
    ]);
    // Deliberately loose OUTPUTS: `sdkOutputSchema` swaps a non-object output
    // schema (a union, an array, a nullable) for `z.looseObject({})` because
    // the SDK's own re-validation dies on anything else — `structuredSuccess`
    // still parses the precise schema before returning. A new name here means
    // a tool lost its advertised output shape.
    const LOOSE_OUTPUT_TOOLS = new Set([
      "list_problems",
      "get_usda_food",
      "find_usda_food",
    ]);
    const isEmpty = (schema: unknown) => {
      const properties = (schema as { properties?: Record<string, unknown> })
        ?.properties;
      return properties !== undefined && Object.keys(properties).length === 0;
    };

    expect(
      tools
        .filter(
          (tool) =>
            !NO_ARGUMENT_TOOLS.has(tool.name) && isEmpty(tool.inputSchema),
        )
        .map((tool) => tool.name),
    ).toEqual([]);
    expect(
      tools
        .filter(
          (tool) =>
            !LOOSE_OUTPUT_TOOLS.has(tool.name) && isEmpty(tool.outputSchema),
        )
        .map((tool) => tool.name),
    ).toEqual([]);

    // …and both allowlists stay honest: an entry that no longer has an empty
    // schema is stale and must be deleted, not left to cover a future tool.
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of NO_ARGUMENT_TOOLS) {
      expect(isEmpty(byName.get(name)?.inputSchema), name).toBe(true);
    }
    for (const name of LOOSE_OUTPUT_TOOLS) {
      expect(isEmpty(byName.get(name)?.outputSchema), name).toBe(true);
    }
  });

  it("keeps a JSON Schema pattern on every shortcode-shaped input field", async () => {
    // Regression: `shortcodeSchema` is deliberately kept a `ZodString` — see the
    // comment on `idParam` in tools/_shared.ts and shortcode.unit.test.ts —
    // specifically because wrapping it in `.transform().pipe()` still parses
    // but silently drops `pattern` from the advertised JSON Schema, which is
    // most of what makes a shortcode self-explanatory to an agent over the
    // wire. That guard lives at the schema level; this walks the LIVE input
    // catalog (SDK registration + safeToJsonSchema + stripMock) so it also
    // catches a future field that swaps `idParam` for a bare `z.string()`, or
    // a catalog-build change that strips `pattern` some other way.
    //
    // Two field names are excluded because they are free text, not cubby
    // entity references, despite the "Id" suffix: `orderId` (a vendor's own
    // order/receipt number — every retailer formats these differently) and
    // `externalId` / `externalAccountId` are provider-owned identifiers (an
    // ASIN, statement id, or account id), not Cubby entity references. The
    // mealRecipe `id` on update_meal_recipe/remove_meal_recipe is the one
    // declared uuid exception (see MCP_SERVER_INSTRUCTIONS) — it's a bare
    // `z.string()` with no pattern at all, by design.
    const FREE_TEXT_ID_FIELDS = new Set([
      "orderId",
      "externalId",
      "expectedExternalId",
      "externalAccountId",
    ]);
    const DECLARED_UUID_EXCEPTIONS = new Set([
      "create_recipe.sections[].id",
      "create_recipe.sections[].ingredients[].id",
      "create_recipe.sections[].instructions[].id",
      "update_meal_recipe.id",
      "update_recipe.sections[].id",
      "update_recipe.sections[].ingredients[].id",
      "update_recipe.sections[].instructions[].id",
      "remove_meal_recipe.id",
      // A statement row is addressed by its content hash (`v1:<sha256>`), which
      // is the provider row's identity — there is no shortcode to carry a
      // prefix, and minting one would imply the ledger is an entity.
      "update_statement_rows.selector.externalIds",
      "update_statement_rows.data.supersededByExternalId",
      "delete_statement_rows.selector.externalIds",
      // The plural mirrors of the singular exceptions above. A batch tool wraps
      // its singular's own input schema in `{items: [...]}`, so it inherits
      // every declared uuid field verbatim — same fields, same reasons.
      "create_recipes.items[].sections[].id",
      "create_recipes.items[].sections[].ingredients[].id",
      "create_recipes.items[].sections[].instructions[].id",
      "update_recipes.items[].sections[].id",
      "update_recipes.items[].sections[].ingredients[].id",
      "update_recipes.items[].sections[].instructions[].id",
      // An Image id is a declared exception — images have no shortcode. These
      // two carry one between create_file_upload and attach_file, so the uuid
      // IS the identifier rather than a leaked internal. Note this covers only
      // `uploadId`: `create_file_upload.entityId` is an `anyShortcodeSchema`
      // and publishes a real prefix pattern, so it passes the check on its own
      // and must stay outside this list — exempting it would let a future
      // change to a bare uuid slip through silently.
      "attach_file.uploadId",
      "attach_files.items[].uploadId",
    ]);

    function stringSchemas(node: unknown): Array<Record<string, unknown>> {
      if (!node || typeof node !== "object") return [];
      const obj = node as Record<string, unknown>;
      if (obj.type === "string") return [obj];
      if (obj.type === "array" && obj.items) return stringSchemas(obj.items);
      if (Array.isArray(obj.anyOf)) return obj.anyOf.flatMap(stringSchemas);
      if (Array.isArray(obj.oneOf)) return obj.oneOf.flatMap(stringSchemas);
      return [];
    }

    function collectIdFields(
      schema: unknown,
      path: string,
      out: Array<{ path: string; node: unknown }>,
      defs: Record<string, unknown>,
      refStack = new Set<string>(),
    ) {
      if (!schema || typeof schema !== "object") return;
      const obj = schema as Record<string, unknown>;
      if (typeof obj.$ref === "string") {
        const refName = obj.$ref.split("/").pop();
        if (!refName || refStack.has(refName)) return;
        const target = defs[refName];
        if (!target) return;
        collectIdFields(
          target,
          path,
          out,
          defs,
          new Set([...refStack, refName]),
        );
        return;
      }
      if (obj.properties && typeof obj.properties === "object") {
        for (const [key, val] of Object.entries(
          obj.properties as Record<string, unknown>,
        )) {
          const p = path ? `${path}.${key}` : key;
          const strings = stringSchemas(val);
          const isIdField = key === "id" || key === "ids" || /Ids?$/.test(key);
          const isUuidField = strings.some((item) => item.format === "uuid");
          if ((isIdField || isUuidField) && !FREE_TEXT_ID_FIELDS.has(key)) {
            out.push({ path: p, node: val });
          }
          collectIdFields(val, p, out, defs, refStack);
        }
      }
      if (obj.items)
        collectIdFields(obj.items, `${path}[]`, out, defs, refStack);
      if (Array.isArray(obj.anyOf)) {
        for (const v of obj.anyOf)
          collectIdFields(v, path, out, defs, refStack);
      }
      if (Array.isArray(obj.oneOf)) {
        for (const v of obj.oneOf)
          collectIdFields(v, path, out, defs, refStack);
      }
      if (Array.isArray(obj.allOf)) {
        for (const v of obj.allOf)
          collectIdFields(v, path, out, defs, refStack);
      }
    }

    const { tools } = await listMcpToolCatalog();
    const violations: string[] = [];
    const stillNeeded = new Set<string>();
    for (const tool of tools) {
      const fields: Array<{ path: string; node: unknown }> = [];
      const inputSchema = tool.inputSchema as Record<string, unknown>;
      const defs =
        (inputSchema.$defs as Record<string, unknown> | undefined) ??
        (inputSchema.definitions as Record<string, unknown> | undefined) ??
        {};
      collectIdFields(inputSchema, "", fields, defs);
      for (const { path, node } of fields) {
        const key = `${tool.name}.${path}`;
        const strings = stringSchemas(node);
        if (strings.length === 0) continue; // not string-shaped (nested object, number, …)
        const lacksShortcodePattern = strings.some(
          (s) =>
            typeof s.pattern !== "string" ||
            !Object.values(SHORTCODE_PREFIX).some((prefix) =>
              (s.pattern as string).includes(prefix),
            ),
        );
        if (DECLARED_UUID_EXCEPTIONS.has(key)) {
          // Only counts as "still needed" if it WOULD have failed. An entry
          // whose field has since gained a real prefix pattern is dead.
          if (lacksShortcodePattern) stillNeeded.add(key);
          continue;
        }
        if (lacksShortcodePattern) violations.push(key);
      }
    }
    expect(violations).toEqual([]);

    // The half the check above cannot see: an exemption is consulted with
    // `continue`, so a path that has since been cut over to a shortcode simply
    // stops matching and its entry survives forever. That is how a dozen image
    // paths outlived the `IMG-` migration. Cutting a field over must now also
    // mean striking it off, or this fails.
    const dead = [...DECLARED_UUID_EXCEPTIONS]
      .filter((key) => !stillNeeded.has(key))
      .sort();
    expect(
      dead,
      `declared uuid exceptions that no longer need exempting.\nThese advertise a real shortcode prefix now — delete them from DECLARED_UUID_EXCEPTIONS:\n${dead
        .map((k) => `  ${k}`)
        .join("\n")}`,
    ).toEqual([]);
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
    const projectCode = "PRJ-2222";
    const result = await callTool(
      createMcpServer(),
      "get_project",
      { id: projectCode },
      {
        project: { getByID: async () => project },
      },
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
  const EXPENSE_A_CODE = "EXP-2222";

  it("passes an allowlisted pair through to search.similar", async () => {
    const similar = vi.fn().mockResolvedValue({
      source: { entityType: "expense", entityId: EXPENSE_A_CODE },
      results: [],
    });

    const result = await callTool(
      createMcpServer(),
      "find_similar_entities",
      { pair: "expense_to_product", sourceId: EXPENSE_A_CODE, limit: 3 },
      { search: { similar } },
    );

    expect(result.isError).not.toBe(true);
    expect(similar).toHaveBeenCalledWith({
      pair: "expense_to_product",
      sourceId: EXPENSE_A_CODE,
      limit: 3,
    });
  });

  it("rejects a combination outside the allowlist before reaching the router", async () => {
    const similar = vi.fn();

    const result = await callTool(
      createMcpServer(),
      "find_similar_entities",
      // A valid seed code, so the rejection can only be about the PAIR.
      { pair: "expense_to_recipe", sourceId: EXPENSE_A_CODE },
      { search: { similar } },
    );

    expect(result.isError).toBe(true);
    expect(similar).not.toHaveBeenCalled();
  });
});

/**
 * An unknown filter key must FAIL, not be silently dropped.
 *
 * Before this, zod stripped it and the tool returned the whole unfiltered set
 * presented as a filtered result — `list_expenses({costMin: 500})` against a
 * build without `costMin` came back with all 1112 rows. These pin the rejection
 * AND the message, because the message is what lets an agent self-correct.
 */
describe("unknown filter keys are rejected", () => {
  it("rejects a misspelled filter and names both it and the valid set", async () => {
    const list = vi.fn();
    const result = await callTool(
      createMcpServer(),
      "list_expenses",
      { costMinn: 500 },
      { expense: { list } },
    );

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    // Names the offending key...
    expect(text).toContain("costMinn");
    // ...and the valid ones, so the caller can fix it without guessing.
    expect(text).toContain("costMin");
    expect(text).toContain("costMax");
    // And says WHY it isn't just ignored.
    expect(text).toContain("rejected rather than ignored");
    // The router was never reached — no chance of returning unfiltered rows.
    expect(list).not.toHaveBeenCalled();
  });

  it("does not trip on the pagination keys that share the same flat object", async () => {
    // `mcpListInputShape` spreads pageIndex/pageSize alongside the filters, so
    // they arrive in the same params object and must not read as filters.
    const list = vi.fn().mockResolvedValue({
      meta: { pageIndex: 1, pageSize: 5, totalCount: 0 },
      items: [],
    });
    const result = await callTool(
      createMcpServer(),
      "list_expenses",
      { pageIndex: 1, pageSize: 5, costMin: 500 },
      { expense: { list } },
    );

    expect(result.isError).not.toBe(true);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { costMin: 500 },
        pagination: { pageIndex: 1, pageSize: 5 },
      }),
    );
  });

  it("passes exact whole-unit quantity bounds through the Expense MCP list", async () => {
    const list = vi.fn().mockResolvedValue({
      meta: { pageIndex: 0, pageSize: 25, totalCount: 0 },
      items: [],
    });
    const result = await callTool(
      createMcpServer(),
      "list_expenses",
      {
        productQuantityPresenceFilter: "has",
        productQuantityMin: 2,
        productQuantityMax: 5,
      },
      { expense: { list } },
    );

    expect(result.isError).not.toBe(true);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          productQuantityPresenceFilter: "has",
          productQuantityMin: 2,
          productQuantityMax: 5,
        },
      }),
    );
  });

  it("guards get_expense_analytics too, which bypasses the list plumbing", async () => {
    // It takes expenseFilterFields directly via registerRouterTool, so it needs
    // its own strict input rather than inheriting registerEntityListTool's.
    const analytics = vi.fn();
    const result = await callTool(
      createMcpServer(),
      "get_expense_analytics",
      { costMaxx: 0 },
      { expense: { analytics } },
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("costMaxx");
    expect(analytics).not.toHaveBeenCalled();
  });

  it("still reports a normal validation error for a KNOWN filter's bad value", async () => {
    // The custom message is scoped to `unrecognized_keys` and must not swallow
    // other issues — a wrong-typed value on a real filter has to say so, not
    // come back as "unknown filter".
    const list = vi.fn();
    const result = await callTool(
      createMcpServer(),
      "list_expenses",
      { costPresenceFilter: "sometimes" },
      { expense: { list } },
    );

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("costPresenceFilter");
    expect(text).not.toContain("Unknown filter");
    expect(list).not.toHaveBeenCalled();
  });

  it("advertises the rule in the published JSON Schema, not just at runtime", async () => {
    // additionalProperties:false tells a well-behaved client up front instead
    // of letting it discover the rule by failing.
    const { tools } = await listMcpToolCatalog();
    const listExpenses = tools.find((t) => t.name === "list_expenses");
    expect(listExpenses?.inputSchema.additionalProperties).toBe(false);
  });
});

describe("MCP response serialization", () => {
  it("keeps a 100-row expense page while compacting its JSON text mirror", async () => {
    const representativeExpense = mock(expenseOut, {
      seed: 100,
      overrides: {
        id: unsafeExpenseShortcode("EXP-6662"),
        name: "Festool CT 36 E HEPA dust extractor with accessories",
        notes:
          "Imported from a vendor receipt; retain this provenance for later reconciliation and duplicate review.",
        url: "https://example.com/orders/representative-wide-expense-row",
      },
    });
    const items = Array.from({ length: 100 }, () => representativeExpense);
    const list = vi.fn().mockResolvedValue({
      meta: { pageIndex: 0, pageSize: 100, totalCount: 100 },
      items,
    });

    const result = await callTool(
      createMcpServer(),
      "list_expenses",
      { pageSize: 100 },
      { expense: { list } },
    );

    expect(result.isError).not.toBe(true);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        pagination: { pageIndex: 0, pageSize: 100 },
      }),
    );
    expect(
      (result.structuredContent as { items: unknown[] }).items,
    ).toHaveLength(100);

    const content = result.content as CallToolResult["content"];
    const text = (content[0] as { type: "text"; text: string }).text;
    const compact = JSON.stringify(result.structuredContent);
    const pretty = JSON.stringify(result.structuredContent, null, 2);
    expect(text).toBe(compact);
    expect(text.length).toBeLessThan(pretty.length * 0.8);
  });
});

describe("household tracker synthesis + bulk tools", () => {
  // project/task/expense are addressed by their public code end to end now —
  // the tool input, the router call, and the row's own `id` are all the same
  // value, so there is nothing left to translate in these tools.
  const PROJECT_A = "PRJ-4442";
  const PROJECT_B = "PRJ-4443";
  const PROJECT_C = "PRJ-4444";
  const TASK_A = "TSK-5552";
  const EXPENSE_A = "EXP-6662";

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
            name: "Order countertop",
            description:
              '"Order countertop" was due 2026-07-22 and is still open',
            entityType: "task",
            entityId: TASK_A,
            date: "2026-07-22",
            amount: null,
            href: "/tasks",
            facts: { due: "2026-07-22", daysOverdue: 4 },
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
      expenseId: unsafeExpenseShortcode("EXP-3333"),
      name: "dust extractor",
      cost: 599,
      date: "2024-06-10",
      future: false,
      notes: null,
      vendorName: null,
      orderId: null,
      projectName: null,
      productName: null,
      purchase: null,
      matchedOn: "amount_date",
      vendorMatch: null,
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
        expenseId: unsafeExpenseShortcode("EXP-3334"),
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

    if (result.isError) throw new Error(JSON.stringify(result.content));
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

  it("previews client-parsed Monarch rows without a CSV/file interface or writes", async () => {
    const previewStatementImport = vi.fn().mockResolvedValue({
      rows: [
        {
          key: "row-1",
          status: "ready_to_create",
          accountId: "FAC-2345",
          accountName: "Citi Double Cash",
          provisionalAccount: null,
          proposed: {
            sourceRef: { source: "monarch", externalId: "v1:abc" },
            amount: 54.29,
            kind: "purchase",
            status: "posted",
            transactionDate: null,
            postedDate: "2026-07-31",
            merchant: "Amazon",
            rawDescription: "AMZN Mktp",
            sourceCategory: "Shopping",
            notes: null,
          },
          existingTransactionIds: [],
        },
      ],
      summary: {
        rowsIn: 1,
        alreadyRecorded: 0,
        readyToCreate: 1,
        possibleExisting: 0,
        unresolvedAccount: 0,
        indistinguishableDuplicate: 0,
      },
    });
    const result = await callTool(
      createMcpServer(),
      "preview_financial_statement_import",
      {
        rows: [
          {
            key: "row-1",
            account: "Citi Double Cash (...1702)",
            date: "2026-07-31",
            amount: -54.29,
            merchant: "Amazon",
            originalStatement: "AMZN Mktp",
            category: "Shopping",
          },
        ],
      },
      { financialTransaction: { previewStatementImport } },
    );

    if (result.isError) throw new Error(JSON.stringify(result.content));
    expect(previewStatementImport).toHaveBeenCalledWith({
      rows: [expect.objectContaining({ source: "monarch", amount: -54.29 })],
    });
    const tool = getRegisteredTool(
      createMcpServer(),
      "preview_financial_statement_import",
    );
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("path");
    expect(JSON.stringify(tool?.inputSchema)).not.toContain("file");
  });

  it("rejects a statement preview batch over 200 rows", async () => {
    const previewStatementImport = vi.fn();
    const result = await callTool(
      createMcpServer(),
      "preview_financial_statement_import",
      {
        rows: Array.from(
          { length: FINANCIAL_STATEMENT_IMPORT_MAX_ROWS + 1 },
          (_, index) => ({
            key: `row-${index}`,
            account: "Citi Double Cash (...1702)",
            date: "2026-07-31",
            amount: -1,
            merchant: null,
            originalStatement: `STATEMENT ${index}`,
            category: null,
            notes: null,
          }),
        ),
      },
      { financialTransaction: { previewStatementImport } },
    );

    expect(result.isError).toBe(true);
    expect(previewStatementImport).not.toHaveBeenCalled();
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

    if (result.isError) throw new Error(JSON.stringify(result.content));
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

  it("generic task batches preserve ordered partial successes", async () => {
    const updated = mock(taskOut, {
      seed: 4,
      overrides: { id: TASK_A, status: "done" },
    });
    const update = vi
      .fn()
      .mockResolvedValueOnce(updated)
      .mockRejectedValueOnce(new Error("write failed"));

    const result = await callTool(
      createMcpServer(),
      "update_tasks",
      {
        items: [
          { id: TASK_A, status: "done" },
          { id: "TSK-7773", status: "done" },
        ],
      },
      { task: { update } },
    );

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      summary: { requested: number; succeeded: number; failed: number };
      results: Array<Record<string, unknown>>;
    };
    expect(structured.summary).toEqual({
      requested: 2,
      succeeded: 1,
      failed: 1,
    });
    // Compact by default: the shortcode, not the hydrated task.
    expect(structured.results[0]).toEqual({
      index: 0,
      status: "succeeded",
      id: TASK_A,
    });
    expect(structured.results[1]).toMatchObject({
      index: 1,
      status: "failed",
      error: "write failed",
    });
  });

  it("rejects duplicate IDs before a generic update batch writes", async () => {
    const updated = mock(expenseOut, {
      seed: 5,
      overrides: { id: EXPENSE_A, projectId: PROJECT_A },
    });
    const update = vi.fn().mockResolvedValue(updated);

    const result = await callTool(
      createMcpServer(),
      "update_expenses",
      {
        items: [
          { id: EXPENSE_A, projectId: PROJECT_A },
          { id: EXPENSE_A, projectId: null },
        ],
      },
      { expense: { update } },
    );

    expect(result.isError).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("purchase restructuring tools (split/link/merge)", () => {
  const EXPENSE_A = "EXP-7772";
  const EXPENSE_B = "EXP-7773";
  const PURCHASE_A = "PUR-8882";

  it("retires delete_empty_purchases in favour of delete_entity", async () => {
    // Its two distinguishing properties are preserved rather than dropped:
    // `delete_entity` dispatches purchase through the SAME require-empty policy
    // (so it still refuses anything carrying live money), and it reports a
    // measured count. What is gone is a second door to the same operation.
    const { tools } = await listMcpToolCatalog();
    const names = new Set(tools.map(({ name }) => name));
    expect(names.has("delete_empty_purchases")).toBe(false);
    expect(names.has("delete_expenses")).toBe(false);
    expect(names.has("delete_entity")).toBe(true);
  });

  it("split_expense is WRITE_CLOSED, wraps the array result in items, and passes params through", async () => {
    const server = createMcpServer();
    expect(getRegisteredTool(server, "split_expense")?.annotations).toEqual(
      WRITE_CLOSED,
    );

    const parts = [
      mock(expenseOut, { seed: 10, overrides: { id: EXPENSE_A, name: "Saw" } }),
      mock(expenseOut, {
        seed: 11,
        overrides: { id: EXPENSE_B, name: "Blade" },
      }),
    ];
    const split = vi.fn().mockResolvedValue(parts);
    // `split_expense` reads the original's cost via `expense.getByID` before
    // splitting — the row is soft-deleted by the time `purchase.split` returns,
    // so this is the tool's only chance to capture it for the response's cue.
    const getByID = vi
      .fn()
      .mockResolvedValue(
        mock(expenseOut, { seed: 12, overrides: { cost: 100 } }),
      );

    const input = {
      expenseId: EXPENSE_A,
      parts: [
        {
          name: "Saw",
          cost: 80,
          costType: "materials",
          trade: "other",
          projectId: null,
          productId: null,
          productQuantity: null,
          notes: "line evidence",
        },
        {
          name: "Blade",
          cost: 20,
          costType: "materials",
          trade: "other",
          projectId: null,
          productId: null,
          productQuantity: null,
        },
      ],
    };

    const result = await callTool(server, "split_expense", input, {
      purchase: { split },
      expense: { getByID },
    });

    expect(getByID).toHaveBeenCalledWith({ id: EXPENSE_A });
    expect(split).toHaveBeenCalledWith(input);
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      items: Array<Record<string, unknown>>;
      originalCost: number | null;
      partsSum: number;
      delta: number | null;
    };
    expect(structured.items).toHaveLength(2);
    expect(structured.items[0]?.id).toBe(EXPENSE_A);
    expect(structured.items[1]?.id).toBe(EXPENSE_B);
    // 80 + 20 from the input parts above, matched exactly against the
    // original's mocked cost — a non-zero delta is exercised in the
    // `splitExpenseDelta` unit tests in packages/schemas.
    expect(structured.originalCost).toBe(100);
    expect(structured.partsSum).toBe(100);
    expect(structured.delta).toBe(0);
  });

  it("link_expenses_to_purchase is WRITE_CLOSED and passes params through to purchase.link", async () => {
    const server = createMcpServer();
    expect(
      getRegisteredTool(server, "link_expenses_to_purchase")?.annotations,
    ).toEqual(WRITE_CLOSED);

    const linked = mock(purchaseOut, {
      seed: 12,
      overrides: { id: PURCHASE_A },
    });
    const link = vi.fn().mockResolvedValue(linked);

    const input = {
      purchaseId: PURCHASE_A,
      expenseIds: [EXPENSE_A, EXPENSE_B],
    };
    const result = await callTool(server, "link_expenses_to_purchase", input, {
      purchase: { link },
    });

    expect(link).toHaveBeenCalledWith(input);
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { id: string }).id).toBe(PURCHASE_A);
  });

  it("merge_entity is WRITE_DESTRUCTIVE_CLOSED and dispatches per entity", async () => {
    const server = createMcpServer();
    expect(getRegisteredTool(server, "merge_entity")?.annotations).toEqual(
      WRITE_DESTRUCTIVE_CLOSED,
    );

    // The four per-entity merge tools this replaced are gone, not renamed.
    for (const retired of [
      "merge_products",
      "merge_ingredients",
      "merge_vendors",
      "merge_purchases",
    ]) {
      expect(
        getRegisteredTool(server, retired),
        `${retired} should have been replaced by merge_entity`,
      ).toBeUndefined();
    }

    const VENDOR_A = "VEN-9992";
    const VENDOR_B = "VEN-9993";
    const kept = mock(vendorOut, { seed: 14, overrides: { id: VENDOR_A } });
    const merge = vi.fn().mockResolvedValue({
      vendor: kept,
      mergeSummary: {
        keepId: VENDOR_A,
        deletedIds: [VENDOR_B],
        merged: 1,
        purchasesRepointed: 0,
        purchasesFolded: 0,
        carriedFields: [],
      },
    });

    const result = await callTool(
      server,
      "merge_entity",
      {
        entity: "vendor",
        merges: [{ keepId: VENDOR_A, mergeIds: [VENDOR_B] }],
      },
      { vendor: { merge } },
    );

    // Dispatched to the entity's own router method with that entity's shape —
    // the generic tool is a front door, not a new merge implementation.
    expect(merge).toHaveBeenCalledWith({
      keepId: VENDOR_A,
      mergeIds: [VENDOR_B],
    });
    expect(result.isError).not.toBe(true);

    // One result per cluster, carrying the MEASURED removal count rather than
    // mergeIds.length, and the survivor referenced by id only.
    const structured = result.structuredContent as {
      entity: string;
      results: Array<{ keepId: string; status: string; merged?: number }>;
    };
    expect(structured.entity).toBe("vendor");
    expect(structured.results).toHaveLength(1);
    expect(structured.results[0]?.keepId).toBe(VENDOR_A);
    expect(structured.results[0]?.status).toBe("succeeded");
    expect(structured.results[0]?.merged).toBe(1);
  });
});

describe("update_inventory_entry value/unit pairing guard", () => {
  // A valid INV- code is required even though the pairing guard fires before
  // the router call: zod validates `id` against the
  // shortcode pattern BEFORE the handler runs at all, so a raw uuid here would
  // fail at parse time and the test would prove nothing about the pairing
  // guard specifically (see the id-format failure this test used to produce).
  const ENTRY_CODE = "INV-2222";

  it("throws before reaching the router when only value is supplied", async () => {
    const caller = { inventory: { update: vi.fn() } };

    const result = await callTool(
      createMcpServer(),
      "update_inventory_entry",
      { id: ENTRY_CODE, value: 3 },
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
      { id: ENTRY_CODE, unit: "each" },
      caller,
    );

    expect(result.isError).toBe(true);
    expect(caller.inventory.update).not.toHaveBeenCalled();
  });

  it("passes both through when value and unit are supplied together", async () => {
    const updated = {
      id: ENTRY_CODE,
      amount: { value: 3, unit: "each" },
      valuation: null,
      placement: "stock" as const,
      product: null,
      location: null,
    };
    const caller = {
      inventory: { update: vi.fn().mockResolvedValue(updated) },
    };

    const result = await callTool(
      createMcpServer(),
      "update_inventory_entry",
      { id: ENTRY_CODE, value: 3, unit: "each" },
      caller,
    );

    expect(result.isError).not.toBe(true);
    expect(caller.inventory.update).toHaveBeenCalledWith({
      id: ENTRY_CODE,
      data: { amount: { value: 3, unit: "each" } },
    });
  });

  // The third branch: neither value nor unit. Moving an entry to another
  // location without touching its amount is an ordinary operation, and the
  // failure mode is silent — a hook that dropped `rest` would send an empty
  // `data` and no-op the update rather than erroring.
  it("passes the other fields through untouched when neither value nor unit is supplied", async () => {
    const updated = {
      id: ENTRY_CODE,
      amount: { value: 1, unit: "each" },
      valuation: null,
      placement: "stock" as const,
      product: null,
      location: null,
    };
    const caller = {
      inventory: { update: vi.fn().mockResolvedValue(updated) },
    };

    const result = await callTool(
      createMcpServer(),
      "update_inventory_entry",
      { id: ENTRY_CODE, locationId: "LOC-2222" },
      caller,
    );

    expect(result.isError).not.toBe(true);
    expect(caller.inventory.update).toHaveBeenCalledWith({
      id: ENTRY_CODE,
      data: { locationId: "LOC-2222" },
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

  it("keeps direct, indirect, and negative invocation eval cases aligned", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./evals/widget-invocation.json", import.meta.url),
        "utf8",
      ),
    ) as {
      cases: Array<{
        category: "direct" | "indirect" | "negative";
        expectedTool: string | null;
        expectedWidget: string | null;
      }>;
    };
    expect(new Set(fixture.cases.map((item) => item.category))).toEqual(
      new Set(["direct", "indirect", "negative"]),
    );

    const { tools } = await listMcpToolCatalog();
    for (const item of fixture.cases) {
      if (!item.expectedTool) continue;
      const tool = tools.find(
        (candidate) => candidate.name === item.expectedTool,
      );
      expect(tool?.description).toMatch(/^Use this when/u);
      expect(tool?.description).toContain("Do not invoke");
      expect(
        (tool?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri,
      ).toBe(item.expectedWidget);
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

  const serverWithUnionTool = (payload: z.infer<typeof unionOut>) => {
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
      serverWithUnionTool({ total: "not-a-number" } as never),
      "union_out",
      {},
      {},
    )) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});

describe("list-tool output envelopes", () => {
  // Regression: these three tools advertised their router's own schema — a
  // bare ARRAY root — while the SDK re-validates `structuredContent` against
  // the permissive OBJECT `sdkOutputSchema` substitutes for any non-object
  // schema. Every call died with "Invalid structured content ... expected
  // object, received array", so kit composition could not be read back over
  // MCP at all while the write path (attach_product_components) worked. The
  // rows now travel in the same `{items}` envelope every other list tool uses;
  // the routers still return bare arrays to their tRPC callers.
  const cases = [
    {
      tool: "list_product_components",
      args: { parentProductId: "PRD-PWVY" },
      router: "product",
      procedure: "components",
      row: productComponentOut,
    },
    {
      tool: "list_purchase_products",
      args: { purchaseId: "PUR-8882" },
      router: "purchase",
      procedure: "products",
      row: purchaseProductOut,
    },
    {
      tool: "list_project_resources",
      args: { projectId: "PRJ-WXYZ" },
      router: "project",
      procedure: "resources",
      row: projectResourceOut,
    },
  ] as const;

  it.each(cases)(
    "$tool wraps its rows in items",
    async ({ tool, args, router, procedure, row }) => {
      const rows = [mock(row, { seed: 1 }), mock(row, { seed: 2 })];
      const list = vi.fn().mockResolvedValue(rows);

      const result = await callTool(createMcpServer(), tool, args, {
        [router]: { [procedure]: list },
      });

      expect(list).toHaveBeenCalledWith(args);
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(result.structuredContent).toEqual({ items: rows });
    },
  );

  it.each(cases)(
    "$tool advertises the items envelope, not a bare array root",
    async ({ tool }) => {
      // A bare-array root never reaches the client as a usable shape: the SDK
      // swaps it for `z.looseObject({})`, so the catalog advertises nothing and
      // the call then fails validation. Naming `items` here is what proves the
      // declared schema and the returned payload agree.
      const advertised = (await listMcpToolCatalog()).tools.find(
        (entry) => entry.name === tool,
      )?.outputSchema as { properties?: Record<string, { type?: string }> };
      expect(advertised?.properties?.items?.type).toBe("array");
    },
  );
});
