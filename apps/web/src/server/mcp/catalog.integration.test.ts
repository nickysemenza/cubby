import { imageId as parseImageId } from "@cubby/schemas/identifiers";
import { mealCreateInput } from "@cubby/schemas/meal";
import { runPurpose } from "@cubby/schemas/purchase-import";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { fromPartial } from "@total-typescript/shoehorn";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { type JSONType, z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import { runTarget } from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";
import { startPhotoInventoryRun } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  makeExpenseInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import {
  callMcpTool,
  kernelRequestContext,
  listMcpTools,
  type McpTestRequestContext,
} from "./mcp-test-utils";
import { McpOperationContext } from "./operation-context";
import { createMcpServer, listMcpToolCatalog } from "./server";
import type { ToolArguments } from "./tools/tool-registration";

type JsonObject = Extract<JSONType, { [key: string]: JSONType }>;

const readOnly = (openWorld = false) => ({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: openWorld,
});
const write = ({ destructive = false, openWorld = false } = {}) => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: false,
  openWorldHint: openWorld,
});

/**
 * The purchase agent resends every mounted tool's input schema on every model call, so each
 * published schema has a ceiling. Before consolidation the largest tool was
 * `entity` at 242,971 characters and the largest non-kernel tool
 * `prepare_purchase_import` at 8,616. The two entity-kernel tools carry every
 * kind's schema and get their own ceiling; every other tool stays under the
 * workflow ceiling, about twice that largest pre-consolidation workflow tool.
 */
const KERNEL_SCHEMA_BUDGET = 131_072;
const WORKFLOW_SCHEMA_BUDGET = 16_384;
const KERNEL_TOOLS = new Set(["entity", "entity_read"]);

function isObject(value: JSONType | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every `$ref` target and every `properties` map in a schema tree. */
function schemaFaults(schema: JsonObject): string[] {
  const definitions = isObject(schema.definitions) ? schema.definitions : {};
  const faults: string[] = [];
  const visit = (node: JSONType, path: string) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!isObject(node)) return;
    const ref = z.string().safeParse(node.$ref).data;
    if (ref) {
      const name = ref.replace("#/definitions/", "");
      if (!definitions[name]) faults.push(`${path}: dangling ${ref}`);
    }
    if (isObject(node.properties) && "$ref" in node.properties)
      faults.push(`${path}.properties is a $ref, not a map of schemas`);
    for (const [key, value] of Object.entries(node))
      visit(value, `${path}.${key}`);
  };
  visit(schema, "");
  return faults;
}

describe("MCP catalog", () => {
  const ctx = withTestDb("mcp");

  it("publishes the exact tool catalog with annotations derived from its actions", async () => {
    const { tools } = await listMcpToolCatalog();
    expect(
      Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations])),
    ).toEqual({
      entity_read: readOnly(),
      entity: write({ destructive: true }),
      search: readOnly(),
      usda_food: readOnly(true),
      project_overview: readOnly(),
      tasks_overview: readOnly(),
      recipe_insights: readOnly(true),
      nutrition: readOnly(),
      finance_read: readOnly(),
      spending_classification_read: readOnly(),
      spending_classification_write: write(),
      imports_read: readOnly(true),
      activity: readOnly(),
      statement_rows: write({ destructive: true }),
      purchase_import: write(),
      expenses: write(),
      product_enrichment: write(),
      upc: write(),
      photo_run: write(),
      run: write({ openWorld: true }),
      meal_recipe: write(),
      recipe_import: write({ openWorld: true }),
      image: write(),
      data_exception: write(),
    });
  });

  it("keeps every tool read-only-homogeneous", async () => {
    const { tools } = await listMcpToolCatalog();
    for (const tool of tools) {
      const binding = Object.entries(MCP_TOOL_BINDINGS).find(
        ([name]) => name === tool.name,
      )?.[1];
      if (!binding) throw new Error(`${tool.name} has no generated binding`);
      const kinds = new Set(
        Object.values(binding.actions).map((action) => action.kind),
      );
      expect([tool.name, [...kinds]]).toEqual([
        tool.name,
        [tool.annotations?.readOnlyHint ? "query" : "mutation"],
      ]);
    }
  });

  it("keeps each published input schema portable and under its budget", async () => {
    const { tools } = await listMcpToolCatalog();
    const oversized: string[] = [];
    for (const tool of tools) {
      const schema = z.json().parse(tool.inputSchema);
      if (!isObject(schema)) throw new Error(`${tool.name}: no object schema`);
      // Anthropic rejects anyOf/oneOf/allOf at the ROOT of input_schema.
      expect([tool.name, schema.type, "anyOf" in schema]).toEqual([
        tool.name,
        "object",
        false,
      ]);
      expect("oneOf" in schema || "allOf" in schema).toBe(false);
      expect(schema.required).toEqual(["action"]);
      expect(schemaFaults(schema)).toEqual([]);
      const size = JSON.stringify(schema).length;
      const budget = KERNEL_TOOLS.has(tool.name)
        ? KERNEL_SCHEMA_BUDGET
        : WORKFLOW_SCHEMA_BUDGET;
      if (size > budget) oversized.push(`${tool.name}: ${size} > ${budget}`);
    }
    expect(oversized).toEqual([]);
  });

  it("runs one happy-path action through every tool", async () => {
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const call = async (
      tool: string,
      args: ToolArguments,
      requestOverrides: McpTestRequestContext = {},
    ) => {
      const result = await callMcpTool(
        createMcpServer(),
        tool,
        args,
        { ...kernelRequestContext(kernel), ...requestOverrides },
        { entityKernel: kernel },
      );
      if (result.isError)
        throw new Error(
          `${tool}.${String(args.action)}: ${JSON.stringify(result.content)}`,
        );
      return z.looseObject({}).parse(result.structuredContent);
    };
    const createdId = async (entity: string, data: ToolArguments) =>
      z
        .object({ item: z.object({ id: z.string() }) })
        .parse(await call("entity", { action: "create", entity, data })).item
        .id;

    // Member-scoped writers (merchant rules, photo runs) need the actor's party.
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Catalog member",
      kind: "member",
      userId: ctx.actor.userId,
    });

    const ingredientId = await createdId("ingredient", {
      name: "Catalog salt",
      aliases: [],
      naKinds: [],
      usuallyOnHand: false,
    });
    expect(
      await call("entity_read", {
        action: "get",
        entity: "ingredient",
        id: ingredientId,
      }),
    ).toMatchObject({ item: { id: ingredientId } });
    expect(
      await call("search", { action: "global", query: "Catalog salt" }),
    ).toHaveProperty("results");
    // USDA is an external source; the lookup is stubbed at its service port.
    expect(
      await call(
        "usda_food",
        { action: "get", fdcId: 1_234_567 },
        {
          usdaService: fromPartial({ getFoodSummaryByID: async () => null }),
        },
      ),
    ).toEqual({ food: null });
    expect(await call("project_overview", { action: "budget" })).toHaveProperty(
      "totals",
    );
    expect(await call("tasks_overview", { action: "summary" })).toHaveProperty(
      "totalOpen",
    );
    expect(await call("recipe_insights", { action: "tags" })).toEqual({
      items: [],
    });
    expect(
      await call("nutrition", {
        action: "shopping_list",
        from: "2026-01-05",
        to: "2026-01-11",
      }),
    ).toBeDefined();
    expect(await call("finance_read", { action: "imports" })).toBeDefined();
    expect(
      await call("imports_read", {
        action: "external_id_collisions",
        identifiers: [
          { source: "amazon", kind: "asin", externalId: "B0SYNTH001" },
        ],
      }),
    ).toBeDefined();
    expect(await call("activity", { action: "recent" })).toHaveProperty(
      "entries",
    );
    expect(
      await call("statement_rows", {
        action: "record",
        import: {
          source: "monarch",
          label: "Catalog synthetic export",
          fingerprint: "catalog-synthetic-1",
        },
        rows: [
          {
            accountDescriptor: "Synthetic card 0000",
            statementDate: "2026-01-06",
            providerAmount: -12.5,
            rawDescription: "SYNTHETIC SHOP",
          },
        ],
        dryRun: true,
      }),
    ).toBeDefined();

    const vendorId = await createdId(
      "vendor",
      mock(vendorCreateInput, { overrides: { name: "Catalog vendor" } }),
    );
    expect(
      await call("purchase_import", {
        action: "confirm_vendor",
        merchant: "SYNTHETIC SHOP",
        vendorId,
      }),
    ).toMatchObject({ vendorId });

    const { output: expense } = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Catalog combo",
        cost: 40,
        vendor: "Catalog vendor",
        orderId: "CATALOG-1",
      }),
    );
    expect(
      await call("expenses", {
        action: "split",
        expenseId: expense.id,
        parts: [
          { name: "part a", cost: 25, costType: "materials", trade: "other" },
          { name: "part b", cost: 15, costType: "materials", trade: "other" },
        ],
      }),
    ).toMatchObject({ delta: 0 });

    const productId = await createdId("product", {
      name: "Catalog widget",
      upc: "012345678905",
    });
    // Detector rows carry Date timestamps; the action publishes their JSON.
    expect(
      await call("activity", { action: "problems", type: "orphanedProducts" }),
    ).toMatchObject({
      type: "orphanedProducts",
      items: expect.arrayContaining([
        expect.objectContaining({ createdAt: expect.any(String) }),
      ]),
    });
    expect(
      await call("product_enrichment", {
        action: "verify_images",
        items: [{ id: productId }],
      }),
    ).toMatchObject({ summary: { requested: 1, succeeded: 1, failed: 0 } });
    // The barcode is already claimed locally, so no lookup service is asked.
    expect(
      await call("upc", { action: "find_or_create", upc: "012345678905" }),
    ).toMatchObject({ id: productId });
    // Exercise a known exception-eligible gap rather than whichever required
    // field happens to be first as the quality registry grows.
    const purchaseId = z
      .object({ items: z.array(z.object({ id: z.string() })) })
      .parse(await call("entity_read", { action: "list", entity: "purchase" }))
      .items[0]!.id;
    await call("entity", {
      action: "update",
      entity: "purchase",
      id: purchaseId,
      data: { evidenceExpectation: "required" },
    });
    const detail = await call("entity_read", {
      action: "get",
      entity: "purchase",
      id: purchaseId,
      resultDetail: "full",
    });
    const [gap] = z
      .object({
        item: z.object({
          dataQuality: z.object({
            gaps: z.array(z.object({ check: z.string(), kind: z.string() })),
          }),
        }),
      })
      .parse(detail)
      .item.dataQuality.gaps.filter(
        (candidate) => candidate.check === "primary_document",
      );
    expect(gap).toBeDefined();
    expect(
      await call("data_exception", {
        action: "set",
        entityId: purchaseId,
        check: gap!.check,
        reason: "not_issued",
        note: "The synthetic vendor issued no receipt.",
      }),
    ).toHaveProperty("status");

    const recipeId = z.object({ id: z.string() }).parse(
      await call("recipe_import", {
        action: "from_text",
        name: "Catalog toast",
        sections: [
          { ingredients: ["1 slice bread"], instructions: ["Toast."] },
        ],
      }),
    ).id;
    const mealId = await createdId(
      "meal",
      mock(mealCreateInput, {
        overrides: { date: "2026-01-07", name: "Catalog lunch" },
      }),
    );
    expect(
      await call("meal_recipe", { action: "add", mealId, recipeId }),
    ).toMatchObject({ id: mealId });

    const photo = await createImageFixture(ctx.db, "catalog-photo", {
      status: "UPLOADED",
    });
    expect(
      await call("image", {
        action: "attach_existing",
        imageId: photo.shortcode,
        targetId: productId,
      }),
    ).toBeDefined();

    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const target = await createImageFixture(ctx.db, "catalog-target", {
      status: "UPLOADED",
      sha256: "a".repeat(64),
    });
    await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: run.id,
        entityKind: "image",
        entityId: parseImageId.parse(target.id),
        position: 0,
        state: "pending",
        targetFingerprint: "a".repeat(64),
      });
    expect(
      await call("photo_run", {
        action: "propose_groups",
        runId: run.publicId,
        groups: [
          {
            groupKey: "catalog-skip",
            product: { kind: "create", create: { name: "Catalog mug" } },
            skip: [{ id: target.shortcode, reason: "Out of focus" }],
          },
        ],
      }),
    ).toHaveProperty("proposals");
  });

  it("refuses legacy purchase_import mutations for a focused research run purpose", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Catalog gate member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Catalog gate actor",
      actorEmail: "catalog-gate-actor@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      trigger: "manual",
      agentSessionId: "catalog-gate-run",
      purpose: runPurpose.parse("purchase_validation"),
      status: "running",
    });
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const trusted = {
      entityKernel: kernel,
      purchaseAgent: { runId: run.id, grantId: "catalog-grant" },
    };
    const execution = { runId: run.id, operationId: "commit:catalog-order" };
    const commit = await callMcpTool(
      createMcpServer(),
      "purchase_import",
      {
        action: "commit",
        _runExecution: execution,
        prepareOperationId: "prepare:catalog-order",
        resolutions: [],
      },
      kernelRequestContext(kernel),
      trusted,
    );
    expect(commit.isError).toBe(true);
    expect(JSON.stringify(commit.content)).toContain(
      "does not mount purchase_import.commit",
    );

    // Legacy validation is refused by the same purpose gate before its writer.
    const validate = await callMcpTool(
      createMcpServer(),
      "purchase_import",
      {
        action: "validate",
        _runExecution: { ...execution, operationId: "validate:catalog-order" },
        prepareOperationId: "prepare:catalog-order",
        resolutions: [],
      },
      kernelRequestContext(kernel),
      trusted,
    );
    const stage = (result: typeof commit) =>
      z
        .object({
          "cubby/error": z.object({
            diagnostics: z.object({ stage: z.string() }),
          }),
        })
        .parse(result._meta)["cubby/error"].diagnostics.stage;
    expect(stage(commit)).toBe("context");
    expect(validate.isError).toBe(true);
    expect(stage(validate)).toBe("context");
  });

  it("shows a purchase agent only its run purpose's actions", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Catalog photo member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const requestContext = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    });
    const { tools } = await listMcpTools(
      createMcpServer(),
      {},
      {
        operationContext: new McpOperationContext(requireActor(requestContext)),
        purchaseAgent: { runId: run.id, grantId: "catalog-photo-grant" },
      },
    );
    const actionsOf = (name: string) =>
      z
        .object({
          properties: z.object({
            action: z.object({ enum: z.array(z.string()) }),
          }),
        })
        .parse(tools.find((tool) => tool.name === name)?.inputSchema).properties
        .action.enum;

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "entity_read",
      "imports_read",
      "photo_run",
      "product_enrichment",
      "search",
    ]);
    expect(actionsOf("entity_read")).toEqual(["resolve"]);
    expect(actionsOf("photo_run")).toEqual(["propose_groups"]);
    expect(actionsOf("product_enrichment")).toEqual(["patch_external_ids"]);
    expect(actionsOf("imports_read").sort()).toEqual([
      "image_processing",
      "photo_candidates",
      "photo_context",
      "photo_proposals",
    ]);
  });
});
