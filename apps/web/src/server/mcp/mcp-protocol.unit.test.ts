import {
  productOut as productTopLevelOut,
  productDetailOut as productWithFoodOut,
} from "@cubby/schemas/entities/product";
import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { mealRecipeOut } from "@cubby/schemas/meal";
import {
  buildNutrition,
  type NutritionTotals,
  withMacros,
} from "@cubby/schemas/nutrition";
import { foodSummary } from "@cubby/usda";
import {
  Client,
  type ClientOptions,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { projectEntityResult } from "~/contracts/mcp-projections";
import { MCP_TOOL_DESCRIPTIONS } from "~/contracts/mcp-tools";
import { mock } from "~/lib/test/mock-schema";
import type { Database } from "~/server/db";
import {
  entityMcpReadCommandSchema,
  entityMutationReadResultSchema,
} from "~/server/entity-kernel/contracts";

import {
  bindingsWithKernelExecutor,
  callMcpTool,
  mcpTestPrincipal,
  observedMcpRuntime,
} from "../testing/mcp-test-utils";
import type { McpEntityExecutor } from "./kernel-actions";
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
    MCP_TOOL_DESCRIPTIONS,
    runtime ?? observedMcpRuntime({}),
  );
  return server;
}

const emit = vi.fn(async () => undefined);

/** A real HTTP MCP client against the production handler. */
function httpClient(
  versionNegotiation: NonNullable<ClientOptions["versionNegotiation"]>,
  responseTypes: Array<string | null> = [],
) {
  const client = new Client(
    { name: "test", version: "1.0.0" },
    { versionNegotiation, jsonSchemaValidator: createMcpClientValidator() },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("https://cubby.test/api/mcp"),
    {
      fetch: async (input, init) => {
        const response = await handleMcpRequest(
          new Request(input, init),
          undefined,
          {
            token: "",
            clientId: "test",
            scopes: [],
            extra: {
              principal: mcpTestPrincipal({}),
              telemetry: {
                identity: {
                  userId: "user_1",
                  clientId: "test",
                  surface: "external_mcp",
                },
                emit,
              },
            },
          },
        );
        // Dispatch must finish before the private Worker binding closes its
        // database client, so no response may stream.
        if (response.status === 200) {
          responseTypes.push(response.headers.get("content-type"));
        }
        return response;
      },
    },
  );
  return { client, connect: () => client.connect(transport) };
}

describe("MCP protocol smoke", () => {
  it("serves catalog, tool calls, and authenticated telemetry over modern MCP HTTP", async () => {
    const responseTypes: Array<string | null> = [];
    const { client, connect } = httpClient(
      { mode: { pin: "2026-07-28" } },
      responseTypes,
    );
    try {
      await connect();
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
        name: "activity_read",
        arguments: {
          action: "report",
          input: { type: "notAProblemType" },
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      expect(responseTypes.length).toBeGreaterThan(0);
      expect(responseTypes).toEqual(
        responseTypes.map(() => expect.stringContaining("application/json")),
      );
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          clientId: "test",
          surface: "external_mcp",
          toolName: "activity_read",
          outcome: "success",
          registeredAtCall: true,
        }),
      );
    } finally {
      await client.close();
    }
  });

  it("serves household playbooks as a read-only tool and skill:// resources", async () => {
    const { client, connect } = httpClient({ mode: { pin: "2026-07-28" } });
    try {
      await connect();
      const call = async (args: Record<string, string>) => {
        const result = await client.callTool({
          name: "playbook",
          arguments: args,
        });
        expect(result.isError).not.toBe(true);
        return result.structuredContent;
      };
      expect(await call({ action: "list" })).toMatchObject({
        playbooks: expect.arrayContaining([
          expect.objectContaining({ name: "purchase-import" }),
        ]),
      });
      expect(
        await call({ action: "get", name: "log-household-maintenance" }),
      ).toMatchObject({
        content: expect.stringMatching(
          /^---\nname: log-household-maintenance/u,
        ),
      });
      expect(
        await call({ action: "read", path: "README.md", heading: "#tenets" }),
      ).toMatchObject({ content: expect.stringMatching(/Tenets/u) });

      const { contents } = await client.readResource({
        uri: "skill://purchase-import/SKILL.md",
      });
      expect(contents[0]).toMatchObject({
        uri: "skill://purchase-import/SKILL.md",
        text: expect.stringMatching(/^---\nname: purchase-import/u),
      });
    } finally {
      await client.close();
    }
  });

  it("rejects a 2025-era initialize handshake naming the supported revision", async () => {
    const { client, connect } = httpClient({ mode: "legacy" });
    try {
      await expect(connect()).rejects.toThrow(/2026-07-28/u);
    } finally {
      await client.close();
    }
  });

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
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining([
        "entities://catalog",
        "skill://purchase-import/SKILL.md",
        "skill://purchase-import/references/audit.md",
      ]),
    );
    expect(entityInput.properties?.action).toBeDefined();
    // The per-entity tools (`list_products`, `get_recipe`, ...) were folded
    // into `entity` / `entity_read`; none may come back.
    expect(
      [...names].filter((name) =>
        /^(get|list|search|create|update|delete)_(?!read$)/u.test(name),
      ),
    ).toEqual([]);
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
    const server = kernelServer(
      runEntity,
      observedMcpRuntime({ recordDatabaseWrite }),
    );

    // The tool boundary validates the injected kernel capability before it
    // dispatches. The executor is mocked here, so only that capability shape
    // is exercised, not a database-backed operation.
    const entityKernel = {
      // SAFETY: a pool-bound stand-in; the runner's after-commit work runs at once.
      db: fromAny<Database, object>({}),
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
    ["cookbook", { id: "CBK-2ABC", name: "Synthetic book" }, "Synthetic book"],
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

  it.each(["summary", "full"] as const)(
    "preserves the same bounded write receipt in %s mode",
    (resultDetail) => {
      const receipt = {
        action: "update",
        entity: "product",
        item: { id: "PRD-2ABC", name: "Synthetic product" },
        appliedFields: ["name"],
        sideEffects: { derivedRefresh: { mode: "background" } },
      } satisfies z.infer<typeof entityMutationReadResultSchema>;
      expect(projectEntityResult({ resultDetail }, receipt)).toEqual(receipt);
    },
  );

  const nullKernel = {
    entityKernel: {
      // SAFETY: a pool-bound stand-in; the runner's after-commit work runs at once.
      db: fromAny<Database, object>({}),
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
        attachments: [],
        sources: [],
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
        attachments: [],
        sources: [],
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
    const meal = mock(entityFieldEnvelopeSchemas.meal.mcpList, {
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
      overrides: {
        fields: {
          food: {
            result: {
              kind: "live",
              decision: {
                outcome: { kind: "value", value: food },
                provenance: { kind: "computed" },
              },
            },
          },
        },
        externalIds: [],
      },
    });
    const ingredientSchema = entityFieldEnvelopeSchemas.ingredient.mcpDetail;
    const embedded = mock(ingredientSchema.shape.product.element, {
      overrides: {
        fields: {
          food: {
            result: {
              kind: "live",
              decision: {
                outcome: { kind: "value", value: food },
                provenance: { kind: "computed" },
              },
            },
          },
        },
        externalIds: [],
      },
    });
    const recipe = {
      ...mock(ingredientSchema.shape.recipe.unwrap()),
      notes: "a headnote that repeats once per usage row",
    };
    const ingredient = mock(ingredientSchema, {
      overrides: { recipe, appearsInRecipes: [recipe], product: [embedded] },
    });
    const runEntity: ExecuteEntity = async (_context, command) =>
      command.entity === "product"
        ? {
            action: "get",
            entity: "product",
            item: {
              ...product,
              attachments: [],
              sources: [],
            },
          }
        : {
            action: "get",
            entity: "ingredient",
            item: {
              ...ingredient,
              attachments: [],
              sources: [],
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
    const server = kernelServer(
      runEntity,
      observedMcpRuntime({ recordDatabaseWrite }),
    );

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
    expect(recordDatabaseWrite).toHaveBeenCalledWith("entity.commands");
  });
  it("projects summary references and full receipts without an expanded output read", async () => {
    const full = mock(productTopLevelOut, { overrides: { externalIds: [] } });
    const runEntity = vi.fn<ExecuteEntity>(
      async (_context, command, detail) => {
        if (command.action !== "create" || command.entity !== "product")
          throw new Error("Unexpected command");
        if (detail !== undefined)
          throw new Error("Mutation requested a hidden expanded read");
        return {
          action: "create",
          entity: "product",
          item:
            command.data.name === "Missing receipt identity"
              ? { name: command.data.name }
              : { id: full.id, name: command.data.name },
          appliedFields: ["name"],
          sideEffects: { derivedRefresh: { mode: "background" } },
        };
      },
    );
    const server = kernelServer(runEntity);
    const command = {
      action: "create",
      entity: "product",
      data: { name: "Synthetic batch product" },
    };
    const summary = await callMcpTool(
      server,
      "entity",
      { action: "commands", commands: [command] },
      {},
      nullKernel,
    );
    expect(summary.isError).not.toBe(true);
    expect(summary.structuredContent).toEqual({
      summary: { requested: 1, succeeded: 1, failed: 0 },
      results: [{ index: 0, status: "succeeded", reference: full.id }],
    });
    const detail = await callMcpTool(
      server,
      "entity",
      { action: "commands", commands: [command], resultDetail: "full" },
      {},
      nullKernel,
    );
    expect(detail.isError).not.toBe(true);
    expect(detail.structuredContent).toMatchObject({
      summary: { succeeded: 1, failed: 0 },
      results: [{ item: { item: { id: full.id, name: command.data.name } } }],
    });
    const invalidFull = await callMcpTool(
      server,
      "entity",
      {
        action: "commands",
        commands: [{ ...command, data: { name: "Missing receipt identity" } }],
        resultDetail: "full",
      },
      {},
      nullKernel,
    );
    expect(invalidFull.structuredContent).toMatchObject({
      summary: { succeeded: 0, failed: 1 },
      results: [{ status: "failed" }],
    });
  });
});
