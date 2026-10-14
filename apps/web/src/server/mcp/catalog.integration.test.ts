import { imageId as parseImageId } from "@cubby/schemas/identifiers";
import { mealCreateInput } from "@cubby/schemas/meal";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { fromPartial } from "@total-typescript/shoehorn";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import {
  photoRunImage,
  assessmentState as suggestion,
  runFinding,
} from "~/server/db/schema";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { startPhotoInventoryRun } from "~/server/purchase-import/run-service";
import { getDb } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  makeExpenseInput,
} from "~/server/repo/repo.fixtures";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { ensureRun } from "~/server/runs/ensure-run";
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

describe("MCP catalog", () => {
  const ctx = withTestDb("mcp");

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
          {
            lineKind: "principal",
            name: "part a",
            cost: 25,
            costType: "materials",
            trade: "other",
          },
          {
            lineKind: "principal",
            name: "part b",
            cost: 15,
            costType: "materials",
            trade: "other",
          },
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
      data: { itemizationExpectation: "required" },
    });
    // An allocation slice is never an itemization, so the gap is open.
    await call("entity", {
      action: "create",
      entity: "expense",
      data: {
        lineKind: "principal",
        name: "Synthetic lump booking",
        purchaseId,
        cost: 12,
        date: "2026-09-01",
        costType: "materials",
        trade: "other",
        lineBasis: "allocation",
      },
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
        (candidate) => candidate.check === "purchase_itemization",
      );
    expect(gap).toBeDefined();
    expect(
      await call("data_exception", {
        action: "set",
        entityId: purchaseId,
        check: gap!.check,
        reason: "unavailable",
        note: "The synthetic order's item lines are no longer available.",
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
      .insert(photoRunImage)
      .values({
        runId: run.id,
        imageId: parseImageId.parse(target.id),
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

  it("refuses purchase_import mutations for a run purpose that does not mount them", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Catalog gate member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const commit = await callMcpTool(
      createMcpServer(),
      "purchase_import",
      {
        action: "commit",
        _runExecution: { runId: run.id, operationId: "commit:catalog-order" },
        prepareOperationId: "prepare:catalog-order",
        resolutions: [],
      },
      kernelRequestContext(kernel),
      {
        entityKernel: kernel,
        purchaseAgent: { runId: run.id, grantId: "catalog-grant" },
      },
    );
    expect(commit.isError).toBe(true);
    expect(JSON.stringify(commit.content)).toContain(
      "does not mount purchase_import.commit",
    );
    // The purpose gate refuses before the writer runs.
    expect(
      z
        .object({
          "cubby/error": z.object({
            diagnostics: z.object({ stage: z.string() }),
          }),
        })
        .parse(commit._meta)["cubby/error"].diagnostics.stage,
    ).toBe("context");
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
      "entity",
      "entity_read",
      "imports_read",
      "photo_run",
      "search",
    ]);
    expect(actionsOf("entity")).toEqual(["update"]);
    expect(actionsOf("entity_read")).toEqual(["resolve"]);
    expect(actionsOf("photo_run")).toEqual(["propose_groups"]);
    expect(actionsOf("imports_read").sort()).toEqual([
      "image_processing",
      "photo_candidates",
      "photo_context",
      "photo_proposals",
    ]);
  });

  // Failure modes: the outer action hides the writer's choice; omission or
  // an unsupported choice must not resolve the retained finding.
  it("dismisses and applies retained findings through the published operation action", async () => {
    const { tools } = await listMcpToolCatalog();
    expect(
      tools.find((tool) => tool.name === "run")?.inputSchema,
    ).toMatchObject({
      properties: { operationAction: { enum: ["apply", "dismiss"] } },
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic finding member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    const [finding] = await getDb(ctx.db)
      .insert(runFinding)
      .values({
        runId,
        ledgerPartyId: party.id,
        entityKind: "run",
        entityId: runId,
        kind: "synthetic-review",
        summary: "Synthetic review finding",
        evidenceFingerprint: "synthetic-review-fingerprint",
      })
      .returning();
    if (!finding) throw new Error("Synthetic finding missing");
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const call = (operationAction?: string) => {
      const args: ToolArguments = { action: "resolve_finding", id: finding.id };
      if (operationAction !== undefined) args.operationAction = operationAction;
      return callMcpTool(
        createMcpServer(),
        "run",
        args,
        kernelRequestContext(kernel),
        { entityKernel: kernel },
      );
    };
    expect((await call()).isError).toBe(true);
    expect((await call("unsupported")).isError).toBe(true);
    const result = await call("dismiss");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      id: finding.id,
      status: "dismissed",
    });
    const retained = await getDb(ctx.db).select().from(runFinding);
    expect(retained).toMatchObject([
      {
        id: finding.id,
        status: "dismissed",
        resolvedByUserId: ctx.actor.userId,
      },
    ]);
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic finding Product",
      manufacturer: "Synthetic maker",
    });
    const { output: expense } = await createRepoEntity(
      ctx,
      "expense",
      makeExpenseInput({
        name: "Synthetic unbound line",
        cost: 12,
        productId: null,
      }),
    );
    const expenseId = await resolveOrThrow(ctx.db, "expense", expense.id);
    const [proposal] = await getDb(ctx.db)
      .insert(runFinding)
      .values({
        ledgerPartyId: party.id,
        entityKind: "expense",
        entityId: expenseId,
        kind: "product_unresolved",
        summary: "Synthetic reviewed Product identity",
        evidenceFingerprint: "synthetic-product-fingerprint",
        proposedFix: {
          kind: "relink_product",
          expenseId,
          productId: product.id,
        },
      })
      .returning();
    if (!proposal) throw new Error("Synthetic proposal missing");
    const applied = await callMcpTool(
      createMcpServer(),
      "run",
      {
        action: "resolve_finding",
        operationAction: "apply",
        id: proposal.id,
      },
      kernelRequestContext(kernel),
      { entityKernel: kernel },
    );
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      id: proposal.id,
      status: "applied",
    });
    const readback = await callMcpTool(
      createMcpServer(),
      "entity_read",
      {
        action: "get",
        entity: "expense",
        id: expense.id,
        resultDetail: "full",
      },
      kernelRequestContext(kernel),
      { entityKernel: kernel },
    );
    expect(readback.isError).not.toBe(true);
    expect(readback.structuredContent).toMatchObject({
      item: { cost: 12, productId: product.shortcode },
    });
  });

  // Regression: the unfiltered queue returned each suggestion's stored record
  // uuid instead of the record's shortcode.
  it("names suggestion queue records by shortcode", async () => {
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const call = (args: ToolArguments) =>
      callMcpTool(
        createMcpServer(),
        "entity_read",
        args,
        kernelRequestContext(kernel),
        { entityKernel: kernel },
      );
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic suggestion product",
      manufacturer: "Synthetic maker",
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    await getDb(ctx.db).insert(suggestion).values({
      runId,
      entity: "product",
      recordId: product.id,
      field: "model",
      currentValue: null,
      suggestedValue: "Synthetic model",
      confidence: 0.9,
      model: "typesafe/jev",
      kind: "addition",
      status: "pending",
    });
    const queue = await call({ action: "suggestion_queue", entity: "product" });
    expect(queue.isError).not.toBe(true);
    expect(queue.structuredContent).toMatchObject({
      items: [{ entity: "product", recordId: product.shortcode }],
    });
  });
});
