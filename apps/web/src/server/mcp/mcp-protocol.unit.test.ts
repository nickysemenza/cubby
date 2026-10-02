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
import { foodSummary } from "@cubby/usda";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { projectEntityResult } from "~/contracts/mcp-projections";
import { MCP_TOOLS } from "~/contracts/mcp-tools";
import { mock } from "~/lib/test/mock-schema";
import {
  ENTITY_KERNEL_ENTITIES,
  entityMcpReadCommandSchema,
} from "~/server/entity-kernel/contracts";

import type { McpEntityExecutor } from "./kernel-actions";
import { bindingsWithKernelExecutor, callMcpTool } from "./mcp-test-utils";
import {
  handleMcpRequest,
  listMcpResourceCatalog,
  listMcpToolCatalog,
} from "./server";
import {
  type McpToolRegistrationRuntime,
  registerMcpTools,
} from "./tools/tool-registration";
import { createMcpClientValidator } from "./validation";

type ExecuteEntity = McpEntityExecutor;

/**
 * The production tools over a synthetic kernel executor: these tests exercise
 * the tool boundary (dispatch, projection, batches), not the repositories.
 */
function kernelServer(
  execute: ExecuteEntity,
  runtime?: McpToolRegistrationRuntime,
) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerMcpTools(
    server,
    bindingsWithKernelExecutor(execute),
    MCP_TOOLS,
    runtime ?? { markCalendarDirty: vi.fn() },
  );
  return server;
}

describe("MCP protocol smoke", () => {
  // ChatGPT's modern catalog refresh failed before dispatch; Flue still uses
  // the legacy handshake. Exercise the actual HTTP client for both eras.
  it.each(["2026-07-28", "2025-11-25"] as const)(
    "serves catalog, tool calls, and authenticated telemetry over MCP %s HTTP",
    async (version) => {
      const emit = vi.fn(async () => undefined);
      const client = new Client(
        { name: "test", version: "1.0.0" },
        {
          versionNegotiation: {
            mode: version === "2026-07-28" ? { pin: version } : "legacy",
          },
          jsonSchemaValidator: createMcpClientValidator(),
        },
      );
      const transport = new StreamableHTTPClientTransport(
        new URL("https://cubby.test/api/mcp"),
        {
          fetch: (input, init) =>
            handleMcpRequest(new Request(input, init), {
              token: "",
              clientId: "test",
              scopes: [],
              extra: {
                requestContext: { db: null, actorContext: null },
                telemetry: {
                  identity: {
                    userId: "user_1",
                    clientId: "test",
                    surface: "external_mcp",
                  },
                  emit,
                },
              },
            }),
        },
      );
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining([
            "search",
            "entity_read",
            "purchase_import",
            "product_enrichment",
          ]),
        );
        // Unsupported problem types return before any database read.
        const result = await client.callTool({
          name: "activity",
          arguments: { action: "problems", type: "notAProblemType" },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toBeDefined();
        expect(emit).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: "user_1",
            clientId: "test",
            surface: "external_mcp",
            toolName: "activity",
            outcome: "success",
            registeredAtCall: true,
          }),
        );
      } finally {
        await client.close();
      }
    },
  );

  it("publishes command and read-only entity capabilities with a discoverable catalog", async () => {
    const [{ tools }, { resources }] = await Promise.all([
      listMcpToolCatalog(),
      listMcpResourceCatalog(),
    ]);
    const names = new Set(tools.map((tool) => tool.name));
    const entityInput = z
      .object({
        properties: z.object({ action: z.json().optional() }).optional(),
      })
      .parse(tools.find((tool) => tool.name === "entity")?.inputSchema);

    expect(names).toContain("entity");
    expect(names).toContain("entity_read");
    expect(
      tools.find((tool) => tool.name === "entity_read")?.annotations
        ?.readOnlyHint,
    ).toBe(true);
    expect(resources.map((resource) => resource.uri)).toContain(
      "entities://catalog",
    );
    expect(entityInput.properties?.action).toBeDefined();
    for (const entity of ENTITY_KERNEL_ENTITIES) {
      for (const operation of ["list", "get", "create", "update"] as const) {
        expect(names).not.toContain(mcpToolName(entity, operation));
      }
    }
    for (const retired of [
      "get_entities",
      "entity_batch",
      "move_inventory_entries",
      "delete_entity",
      "attach_entity",
      "detach_entity",
      "merge_entity",
    ])
      expect(names).not.toContain(retired);
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
    const runEntity = vi.fn<ExecuteEntity>(async (_context, command) => {
      expect(command).toMatchObject({ action: "list", entity: "expense" });
      return {
        action: "list" as const,
        entity: "expense" as const,
        items: [],
        meta: { pageIndex: 0, pageSize: 10, totalCount: 0 },
      };
    });
    const recordDatabaseWrite = vi.fn(async () => {});
    const server = kernelServer(runEntity, {
      markCalendarDirty: vi.fn(),
      recordDatabaseWrite,
    });

    // The tool boundary validates the injected kernel capability before it
    // dispatches. The executor is mocked here, so only that capability shape
    // is exercised, not a database-backed operation.
    const entityKernel = {
      db: null,
      actorContext: null,
      usdaClient: null,
      upcLookupClient: null,
      services: null,
    };

    const result = await callMcpTool(
      server,
      "entity_read",
      { action: "list", entity: "expense" },
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

  const nullKernel = {
    entityKernel: {
      db: null,
      actorContext: null,
      usdaClient: null,
      upcLookupClient: null,
      services: null,
    },
  };

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

    const result = await callMcpTool(
      kernelServer(runEntity),
      "entity_read",
      { action: "get", entity: "product", id: product.id },
      {},
      nullKernel,
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
    const [summary, full] = await Promise.all([
      callMcpTool(
        kernelServer(runEntity),
        "entity_read",
        { action: "get", entity: "product", id: product.id },
        {},
        nullKernel,
      ),
      callMcpTool(
        kernelServer(runEntity),
        "entity_read",
        {
          action: "get",
          entity: "product",
          id: product.id,
          resultDetail: "full",
        },
        {},
        nullKernel,
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

    const result = await callMcpTool(
      kernelServer(runEntity),
      "entity_read",
      { action: "list", entity: "meal", resultDetail: "full" },
      {},
      nullKernel,
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
            item: {
              ...ingredient,
              displayImages: [],
              attachments: [],
              redirectedFrom: null,
              previousShortcodes: [],
            },
          };
    const server = kernelServer(runEntity);

    const productRead = await callMcpTool(
      server,
      "entity_read",
      {
        action: "get",
        entity: "product",
        id: product.id,
        resultDetail: "full",
      },
      {},
      nullKernel,
    );
    const ingredientRead = await callMcpTool(
      kernelServer(runEntity),
      "entity_read",
      {
        action: "get",
        entity: "ingredient",
        id: ingredient.id,
        resultDetail: "full",
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

  it("runs entity.commands independently and reports each outcome", async () => {
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
        sideEffects: {},
      };
    });
    const recordDatabaseWrite = vi.fn(async () => {});
    const server = kernelServer(runEntity, {
      markCalendarDirty: vi.fn(),
      recordDatabaseWrite,
    });

    const result = await callMcpTool(
      server,
      "entity",
      {
        action: "commands",
        commands: [
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
    expect(recordDatabaseWrite).toHaveBeenCalledWith("mcp.entity.commands");
  });
});
