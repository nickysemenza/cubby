import { imageId as parseImageId } from "@cubby/schemas/identifiers";
import { recordShipmentEvidenceInput } from "@cubby/schemas/shipment-evidence";
import { recordSourceTransactionRecordsInput } from "@cubby/schemas/source-transaction-record";
import { sql } from "drizzle-orm";
import { StatusCodes } from "http-status-codes";
import { createRepoEntity } from "tooling/factories/repo";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { withTestDb } from "tooling/test-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { insertFieldsFixture as insertWithShortcode } from "~/server/ai/fields/fields.fixtures";
import { getDb } from "~/server/db/helpers";
import { aiAnalysis, photoRunImage } from "~/server/db/schema";
import { startPhotoInventoryRun } from "~/server/domains/photo-import/repo/run/photo-run";
import { syntheticMailImportRun } from "~/server/domains/purchase-import/service/gmail/execution.fixtures";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { requireActor } from "~/server/http/request-context";
import { decide, recordSubject } from "~/server/kernel/api";
import { drainStoredDerived } from "~/server/testing/background-queue";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import {
  createImageFixture,
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";
import {
  runFinding,
  seedRunFinding,
} from "~/server/testing/run-finding.fixtures";

import {
  callMcpTool,
  kernelRequestContext,
  listMcpTools,
} from "../testing/mcp-test-utils";
import { createMcpServer } from "./server";
import type { ToolArguments } from "./tools/tool-registration";
let backgroundQueue: ReturnType<typeof captureBackgroundQueue>;
beforeEach(() => {
  backgroundQueue = captureBackgroundQueue();
});
afterEach(() => backgroundQueue.restore());

describe("MCP catalog", () => {
  const ctx = withTestDb("mcp");

  // Retained model text must survive the real read and MCP serialization,
  // while the internal analysis row remains outside both response encodings.
  it("photo context reads current-source descriptions without internal analysis handles", async () => {
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic photo evidence member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const hash = "a".repeat(64);
    const photo = await createImageFixture(ctx.db, "synthetic-context-photo", {
      status: "UPLOADED",
      sha256: hash,
    });
    await getDb(ctx.db)
      .insert(photoRunImage)
      .values({
        runId: run.id,
        imageId: parseImageId.parse(photo.id),
        position: 0,
        state: "pending",
        targetFingerprint: hash,
      });
    const createdAt = new Date("2026-10-01T00:00:00.000Z");
    const claims = [{ text: "Red", evidenceKind: "visual" as const }];
    const [analysis] = await getDb(ctx.db)
      .insert(aiAnalysis)
      .values({
        entityKind: "image",
        entityId: photo.id,
        feature: "image-description",
        provider: "synthetic",
        model: "synthetic-description-model",
        promptVersion: "1",
        resultSchemaRevision: 1,
        inputFingerprint: JSON.stringify({ sourceContentHash: hash }),
        result: {
          description: "Synthetic red boot",
          claims,
          cutoutEligibility: "review",
        },
        createdAt,
      })
      .returning({ id: aiAnalysis.id });
    expect(analysis).toBeDefined();
    const result = await callMcpTool(
      createMcpServer(),
      "run_read",
      { action: "run_context", runId: run.publicId },
      kernelRequestContext(kernel),
      { entityKernel: kernel },
    );
    expect(result.isError).not.toBe(true);
    const output = z
      .object({
        images: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
          }),
        ),
      })
      .parse(result.structuredContent);
    expect(output.images).toHaveLength(1);
    expect(output.images[0]).toEqual({
      id: photo.shortcode,
      description: "Synthetic red boot",
    });
    expect(JSON.stringify(result)).not.toContain(analysis!.id);
  });

  // Graph nodes span the root and every branch while pageSize pages each
  // branch, so cutting nodes to pageSize dropped referenced records.
  it("pages a graph branch by cursor without dropping the nodes it references", async () => {
    const product = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic graph pantry staple" }),
      ctx.actor,
    );
    for (const index of [1, 2, 3]) {
      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: `Synthetic graph shelf ${index}` }),
        ctx.actor,
      );
      await createInventoryFixture(
        ctx.db,
        {
          productId: product.id,
          locationId: location.id,
          amount: { value: index, unit: "each" },
        },
        ctx.actor,
      );
    }
    const page = z.object({
      nodes: z.array(z.object({ entityId: z.string() })),
      branches: z.array(
        z.object({ items: z.array(z.object({ entityId: z.string() })) }),
      ),
      nextCursor: z.string().nullable(),
    });
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const read = async (cursor?: string) => {
      const result = await callMcpTool(
        createMcpServer(),
        "entity_graph_read",
        {
          action: "graph",
          input: {
            roots: [{ entityKind: "product", entityId: product.id }],
            relationshipKeys: ["inventory"],
            pageSize: 2,
            ...(cursor && { cursor }),
          },
        },
        kernelRequestContext(kernel),
        { entityKernel: kernel },
      );
      expect(result.isError).not.toBe(true);
      return page.parse(result.structuredContent);
    };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (const expected of [2, 1]) {
      const current = await read(cursor);
      const items = current.branches.flatMap((branch) => branch.items);
      expect(items).toHaveLength(expected);
      const nodes = new Set(current.nodes.map((node) => node.entityId));
      for (const item of items) expect(nodes).toContain(item.entityId);
      seen.push(...items.map((item) => item.entityId));
      cursor = current.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(3);
  });

  // A dry run of an existing collection once scheduled automatic financial work.
  // The public operation boundary, unlike a repository-only test, owns that intent.
  it("keeps dry runs and unchanged evidence replays free of financial Jobs", async () => {
    const input = recordSourceTransactionRecordsInput.parse({
      import: {
        source: "monarch",
        fingerprint: "synthetic-pure-replay",
        label: "Synthetic collection",
        rowCountDeclared: 1,
      },
      rows: [
        {
          accountDescriptor: "Synthetic account",
          statementDate: "2026-09-01",
          providerAmount: -12,
          rawDescription: "SYNTHETIC PURE REPLAY",
          rowPosition: 1,
        },
      ],
    });
    await recordSourceTransactionRecords(ctx.db, input, ctx.actor);
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const snapshot = async () =>
      await getDb(ctx.db).execute(
        sql`
      SELECT (SELECT count(*) FROM "Run") AS runs, (SELECT count(*) FROM "Job") AS jobs,
        (SELECT count(*) FROM "Suggestion") AS suggestions,
        (SELECT coalesce(sum("costMinor"),0) FROM "Expense" WHERE "deletedAt" IS NULL) AS money
    `,
        "objects",
      );
    const before = await snapshot();
    for (const dryRun of [true, false]) {
      const response = await callMcpTool(
        createMcpServer(),
        "finance",
        { action: "record", ...input, dryRun },
        kernelRequestContext(kernel),
        { entityKernel: kernel },
      );
      expect(response.isError).not.toBe(true);
      expect(await snapshot()).toEqual(before);
    }
  });

  // The Mail import agent's entity_read schema carries only its entity kinds;
  // the server must refuse the others, not just leave them unadvertised.
  it("refuses entity_read of a kind outside the Mail import agent's kinds", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Catalog kinds member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await syntheticMailImportRun(ctx.db, ctx.actor, {
      ledgerPartyId: party.id,
      mailboxId: "catalog-kinds@example.com",
    });
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const read = (entity: string) =>
      callMcpTool(
        createMcpServer(),
        "entity_read",
        { action: "list", entity },
        kernelRequestContext(kernel),
        {
          entityKernel: kernel,
          purchaseAgent: { runId, grantId: "catalog-kinds-grant" },
        },
      );
    const recipe = await read("recipe");
    expect(recipe.isError).toBe(true);
    expect(JSON.stringify(recipe.content)).toContain(
      "reads only purchase, vendor, product",
    );
    expect((await read("purchase")).isError).not.toBe(true);
  });

  it("returns input-schema recovery for a delegated shipment write missing its execution envelope", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic envelope member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runId = await syntheticMailImportRun(ctx.db, ctx.actor, {
      ledgerPartyId: party.id,
      mailboxId: "envelope@example.com",
    });
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    // The action input itself is valid, so this exercises the missing envelope after admission.
    const input = recordShipmentEvidenceInput.parse({
      source: {
        kind: "tracking_page",
        url: "https://example.com/tracking",
        externalKey: "synthetic-package",
        capturedAt: "2026-06-06T09:00:00Z",
        content: "Synthetic tracking evidence",
      },
      purchaseId: null,
      shipments: [
        {
          shipmentId: null,
          sourceShipmentKey: "synthetic-package",
          distinctPackageEvidence: null,
          carrierId: null,
          carrierName: "Synthetic Carrier",
          trackingNumber: "SYNTHETIC-123",
          extraTrackingNumbers: [],
          purpose: "incoming",
          observations: [
            {
              sourceEventKey: "synthetic-scan",
              kind: "carrier_possession",
              timeBasis: "stated_event",
              time: { kind: "instant", value: "2026-06-03T09:00:00Z" },
              rawStatus: "Synthetic pickup",
              location: null,
              carrierId: null,
              carrierName: "Synthetic Carrier",
              trackingNumber: "SYNTHETIC-123",
            },
          ],
        },
      ],
    });
    const result = await callMcpTool(
      createMcpServer(),
      "shipments",
      { action: "record", input },
      kernelRequestContext(kernel),
      {
        entityKernel: kernel,
        purchaseAgent: { runId, grantId: "synthetic-envelope-grant" },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta).toMatchObject({
      "cubby/error": {
        code: "BAD_REQUEST",
        reason: "INVALID_INPUT",
        issues: [{ path: ["_runExecution"] }],
      },
    });
    const refusal = z
      .object({
        "cubby/error": z.object({
          code: z.enum(["BAD_REQUEST", "INTERNAL_SERVER_ERROR"]),
        }),
      })
      .parse(result._meta)["cubby/error"];
    expect(StatusCodes[refusal.code]).toBe(400);
    expect(JSON.stringify(result.content)).not.toContain("input_schema");
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
    expect(JSON.stringify(commit.content)).not.toContain("inputSchema");
    expect(JSON.stringify(commit.content)).toContain(
      "does not mount purchase_import.commit",
    );
    const malformed = await callMcpTool(
      createMcpServer(),
      "purchase_import",
      { action: "prepare", input: { orders: [{}] } },
      kernelRequestContext(kernel),
      {
        entityKernel: kernel,
        purchaseAgent: { runId: run.id, grantId: "catalog-grant" },
      },
    );
    expect(malformed.isError).toBe(true);
    expect(JSON.stringify(malformed.content)).not.toContain("inputSchema");
    expect(commit.isError).toBe(true);
    // describe hides unmounted actions too, including from the available list.
    const described = await callMcpTool(
      createMcpServer(),
      "purchase_import",
      { action: "describe", input: { actions: ["commit"] } },
      kernelRequestContext(kernel),
      {
        entityKernel: kernel,
        purchaseAgent: { runId: run.id, grantId: "catalog-grant" },
      },
    );
    expect(described.isError).toBe(true);
    const refusal = JSON.stringify(described.content);
    expect(refusal).toContain("Unknown action");
    expect(refusal).not.toContain("prepare");
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
      requireActor(requestContext),
      {
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
      "image_read",
      "run",
      "run_read",
      "search_read",
    ]);
    expect(actionsOf("entity")).toEqual(["update"]);
    expect(actionsOf("entity_read")).toEqual(["resolve"]);
    expect(actionsOf("run").sort()).toEqual(["describe", "propose_groups"]);
    expect(actionsOf("image_read").sort()).toEqual(["describe", "status"]);
    expect(actionsOf("run_read").sort()).toEqual([
      "describe",
      "product_candidates",
      "proposals",
      "run_context",
    ]);
    expect(actionsOf("search_read")).toEqual(["similar", "describe"]);
  });

  // Failure modes: the outer action hides the writer's choice; omission or
  // an unsupported choice must not resolve the retained finding.
  it("dismisses and applies retained findings through the published operation action", async () => {
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const described = await callMcpTool(
      createMcpServer(),
      "activity",
      { action: "describe", input: { actions: ["resolve_run_finding"] } },
      kernelRequestContext(kernel),
      { entityKernel: kernel },
    );
    expect(described.structuredContent).toMatchObject({
      actions: [
        {
          inputSchema: {
            properties: {
              operationAction: { enum: ["apply", "dismiss", "ask_member"] },
            },
          },
        },
      ],
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
    const finding = await seedRunFinding(ctx.db, {
      runId,
      ledgerPartyId: party.id,
      entityKind: "run",
      entityId: runId,
      kind: "synthetic-review",
      summary: "Synthetic review finding",
      evidenceFingerprint: "synthetic-review-fingerprint",
    });
    if (!finding) throw new Error("Synthetic finding missing");
    const call = (operationAction?: string) => {
      const args: ToolArguments = {
        action: "resolve_run_finding",
        id: finding.id,
      };
      if (operationAction !== undefined) args.operationAction = operationAction;
      return callMcpTool(
        createMcpServer(),
        "activity",
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
      brandId: await findOrCreateVendor(ctx.db, "Synthetic maker"),
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
    const proposal = await seedRunFinding(ctx.db, {
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
    });
    if (!proposal) throw new Error("Synthetic proposal missing");
    const applied = await callMcpTool(
      createMcpServer(),
      "activity",
      {
        action: "resolve_run_finding",
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
      item: {
        cost: 12,
        fields: {
          productId: {
            result: {
              decision: {
                outcome: { kind: "value", value: product.shortcode },
              },
            },
          },
        },
      },
    });
  });

  // Regression: the unfiltered queue returned each suggestion's stored record
  // uuid instead of the record's shortcode.
  it("names suggestion queue records by shortcode", async () => {
    const kernel = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic suggestion product",
      brandId: await findOrCreateVendor(ctx.db, "Synthetic maker"),
    });
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    await decide(ctx.db, ctx.actor, [
      {
        channel: "assignment",
        kind: "set",
        subject: recordSubject("product", product.id),
        field: "model",
        value: "Synthetic current model",
      },
    ]);
    await seedFieldSuggestion(
      ctx.db,
      {
        runId,
        entity: "product",
        recordId: product.id,
        field: "model",
        // A Disagreement: the queue lists what needs a person.
        currentValue: "Synthetic current model",
        suggestedValue: "Synthetic model",
        confidence: 0.9,
        model: "typesafe/jev",
        kind: "correction",
        status: "pending",
      },
      true,
    );
    await drainStoredDerived(ctx.db);
    const queue = await callMcpTool(
      createMcpServer(),
      "suggestions_read",
      { action: "list", entity: "product" },
      kernelRequestContext(kernel),
      { entityKernel: kernel },
    );
    expect(queue.isError).not.toBe(true);
    expect(queue.structuredContent).toMatchObject({
      items: [
        {
          family: "field",
          record: { entity: "product", id: product.shortcode },
          evidence: { entity: "product", recordId: product.shortcode },
        },
      ],
    });
  });
});
