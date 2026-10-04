import { runEntityId, parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { awaitEvent, call, mcp, mcpRead } from "tooling/purchase-agent-script";
import { type TestDbContext, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  aiUsage,
  auditLog,
  entityAttachment,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  image,
  run as runTable,
  runOperation,
  runProgress,
  runTarget,
  importSourceClaim,
  product,
  photoGroupProposal,
  purchase,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import { approvePhotoGroupProposals } from "~/server/photo-import-run/proposals";
import { getDb } from "~/server/repo/database-helpers";
import {
  createImageFixture,
  createProductFixture,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  authorizePurchaseAgent,
  type ScenarioHarness,
  startScenarioHarness,
  waitFor,
  workerdDiagnostic,
} from "./purchase-agent-workerd.fixtures";
import {
  startPhotoInventoryCoordinator,
  startPhotoInventoryRun,
  startTargetedRun,
} from "./run-service";

let scenario: ScenarioHarness | undefined;

async function protectedBusinessSnapshot(
  db: TestDbContext["db"],
  input: {
    purchaseId: typeof purchase.$inferSelect.id;
    productId: typeof product.$inferSelect.id;
  },
) {
  const database = getDb(db);
  const values = await Promise.all([
    database.select().from(purchase).where(eq(purchase.id, input.purchaseId)),
    database
      .select()
      .from(expense)
      .where(eq(expense.purchaseId, input.purchaseId)),
    database.select().from(product).where(eq(product.id, input.productId)),
    database.select().from(image),
    database
      .select()
      .from(entityAttachment)
      .where(eq(entityAttachment.entityId, input.purchaseId)),
    database
      .select()
      .from(entityAttachment)
      .where(eq(entityAttachment.entityId, input.productId)),
    database.select().from(importSourceClaim),
    database.select().from(purchasePaymentEvidence),
    database.select().from(financialTransaction),
    database.select().from(financialTransactionAllocation),
    database.select().from(auditLog),
  ]);
  return JSON.stringify(values);
}

afterEach(async () => {
  await scenario?.close();
  scenario = undefined;
});

describe("purchase-agent coupled two-Worker workerd harness", () => {
  const ctx = withTestDb();

  const waitForRun = async (
    runId: string,
    predicate: () => Promise<boolean>,
    message: string,
  ) => {
    try {
      await waitFor(predicate, message);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${await workerdDiagnostic(ctx.db, runId, scenario?.harness)}`,
        { cause: error },
      );
    }
  };

  it("dispatches a photo run through the agent and MCP, waits for review, then commits only on approval", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic wardrobe member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await startPhotoInventoryRun(ctx.db, {
      actorUserId: ctx.actor.userId,
    });
    const imageFixture = await createImageFixture(
      ctx.db,
      `synthetic-wardrobe-${crypto.randomUUID()}`,
    );
    await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: runEntityId.parse(run.id),
        entityKind: "image",
        entityId: parseEntityId("image", imageFixture.id),
        position: 0,
        state: "pending",
        targetFingerprint: `synthetic-${crypto.randomUUID()}`,
      });
    const started = await startPhotoInventoryCoordinator(ctx.db, {
      publicId: run.publicId,
      actorUserId: ctx.actor.userId,
    });
    expect(started.created).toBe(true);
    expect(
      (
        await startPhotoInventoryCoordinator(ctx.db, {
          publicId: run.publicId,
          actorUserId: ctx.actor.userId,
        })
      ).eventId,
    ).toBe(started.eventId);

    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    const productName = `Synthetic wardrobe item ${crypto.randomUUID()}`;
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("photo-claim", "claim_next_import_work"),
        mcp("photo-propose", "photo_run", run.id, {
          action: "propose_groups",
          runId: run.publicId,
          groups: [
            {
              groupKey: "synthetic-wardrobe-item",
              images: [{ id: imageFixture.shortcode, purpose: "item" }],
              product: { kind: "create", create: { name: productName } },
              evidence:
                "Synthetic item photo; review the proposed identity before creating a Product.",
            },
          ],
        }),
        mcpRead("photo-list", "imports_read", {
          action: "photo_proposals",
          runId: run.publicId,
        }),
        call("photo-await", "report_agent_progress", {
          phase: "awaiting_approval",
          awaitingApproval: true,
          detail: "One synthetic item is ready for review",
        }),
      ],
    });
    await scenario.dispatch({
      version: 1,
      type: "start_or_resume",
      runId: run.id,
      // The persisted run, not a stale queue hint, selects the agent workflow.
      purpose: "account_sync",
      eventId: started.eventId,
    });
    await waitForRun(
      run.id,
      async () => {
        const [proposal, progress, startedProgress, usage] = await Promise.all([
          getDb(ctx.db)
            .select({ state: photoGroupProposal.state })
            .from(photoGroupProposal)
            .where(eq(photoGroupProposal.runId, run.id))
            .limit(1),
          getDb(ctx.db)
            .select({ phase: runProgress.phase })
            .from(runProgress)
            .where(
              and(
                eq(runProgress.runId, run.id),
                eq(runProgress.phase, "awaiting_approval"),
              ),
            )
            .limit(1),
          getDb(ctx.db)
            .select({ id: runProgress.id })
            .from(runProgress)
            .where(
              and(
                eq(runProgress.runId, run.id),
                eq(runProgress.detail, "Coordinator started"),
              ),
            )
            .limit(1),
          getDb(ctx.db)
            .select({ id: aiUsage.id })
            .from(aiUsage)
            .where(eq(aiUsage.runId, run.id))
            .limit(1),
        ]);
        return (
          proposal[0]?.state === "proposed" &&
          progress.length === 1 &&
          startedProgress.length === 1 &&
          usage.length === 1
        );
      },
      "Photo agent did not propose a group and wait for approval",
    );
    expect(
      await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(eq(product.name, productName)),
    ).toHaveLength(0);
    const [waitingRun] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(waitingRun?.status).toBe("running");
    const approval = await approvePhotoGroupProposals(
      ctx.db,
      { runId: run.publicId },
      ctx.actor,
    );
    expect(approval.results[0]?.outcome).toBe("committed");
    expect(
      await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(eq(product.name, productName)),
    ).toHaveLength(1);
    const [settled] = await getDb(ctx.db)
      .select({ status: runTable.status })
      .from(runTable)
      .where(eq(runTable.id, run.id));
    expect(settled?.status).toBe("completed");
    expect(await scenario.violations()).toEqual([]);
  }, 60_000);

  it("uses the production service to fence, pause for browser evidence, resume, and complete without business writes", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Workerd harness member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Workerd harness vendor",
      website: "https://shop.example.test/orders",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Workerd harness account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const targetPurchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      vendorAccountId: account.id,
      orderId: "ORDER-WORKERD-1",
      date: "2026-09-20",
      displayLabel: "Workerd validation target",
      statedTotal: 12.34,
    });
    const targetProduct = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Workerd validation product" }),
      ctx.actor,
    );
    const [targetProductRow] = await getDb(ctx.db)
      .select({ shortcode: product.shortcode })
      .from(product)
      .where(eq(product.id, targetProduct.entityId));
    if (!targetProductRow) throw new Error("Expected validation Product");
    await insertWithShortcode(ctx.db, "expense", {
      purchaseId: targetPurchase.id,
      name: "Workerd validation product",
      cost: 12.34,
      date: "2026-09-20",
      lineKind: "principal",
      costType: "materials",
      trade: "other",
      future: false,
      productId: targetProduct.entityId,
      productQuantity: 1,
    });
    await authorizePurchaseAgent(ctx.db, ctx.actor.userId);
    const sourceExternalKey = "workerd:ORDER-WORKERD-1";
    const evidenceChecksum = "a".repeat(64);
    const started = await startTargetedRun(ctx.db, {
      ledgerPartyId: party.id,
      purpose: "purchase_validation",
      vendorId: vendor.id,
      vendorAccountId: account.id,
      trigger: "manual",
      targets: [
        {
          kind: "purchase",
          purchaseId: targetPurchase.id,
          vendorAccountId: account.id,
          sourceKind: "browser_order",
          sourceExternalKey,
          targetFingerprint: "a".repeat(64),
          evidenceFingerprint: evidenceChecksum,
        },
      ],
    });
    if (!started.created || !started.run.dispatchEventId)
      throw new Error("Expected targeted run dispatch generation");
    const runId = started.run.id;

    const before = await protectedBusinessSnapshot(ctx.db, {
      purchaseId: targetPurchase.id,
      productId: targetProduct.entityId,
    });
    scenario = await startScenarioHarness(ctx.databaseUrl, {
      steps: [
        call("claim-initial", "claim_next_import_work"),
        call("browser-1", "issue_browser_command", {
          operationId: "capture-order",
          command: {
            kind: "capture_order",
            target: "https://shop.example.test/orders/ORDER-WORKERD-1",
          },
        }),
        awaitEvent("browser_connected", "browser_result"),
        call("claim-resume", "claim_next_import_work"),
        awaitEvent("browser_result"),
        mcp(
          "prepare:workerd",
          "purchase_import",
          runId,
          {
            action: "prepare",
            orders: [
              {
                stableOrderId: "order-workerd",
                itemOperationId: "prepare-item:workerd",
                source: {
                  kind: "browser_order",
                  externalKey: sourceExternalKey,
                  checksum: evidenceChecksum,
                },
                evidenceChecksum,
                extractionRevision: "workerd@1",
                extraction: {
                  status: "ready",
                  candidate: {
                    orderId: "ORDER-WORKERD-1",
                    orderedAt: "2026-09-20T12:00:00.000Z",
                    merchant: "Workerd harness vendor",
                    currency: "USD",
                    printedGrandTotal: 12.34,
                    lines: [
                      {
                        title: "Workerd validation product",
                        amount: 12.34,
                        lineKind: "principal",
                        quantity: 1,
                      },
                    ],
                    payments: [],
                    allShipmentsDelivered: false,
                  },
                },
                lineIds: ["order-workerd:line-1"],
                primaryDocumentImageId: null,
                screenshotImageId: null,
              },
            ],
          },
          { itemOperationIds: ["prepare-item:workerd"] },
        ),
        mcp("validate:workerd", "purchase_import", runId, {
          action: "validate",
          prepareOperationId: "prepare:workerd",
          resolutions: [
            {
              stableOrderId: "order-workerd",
              stableLineId: "order-workerd:line-1",
              resolution: {
                kind: "existing",
                productId: targetProductRow.shortcode,
              },
            },
          ],
        }),
        // An unchanged Purchase must compare as `replayed`.
        { check: "validate:workerd", includes: "replayed" },
        call("finish-1", "finish_import_run", {
          operationId: "finish-after-validation",
        }),
      ],
    });
    await scenario.dispatch({
      version: 1,
      type: "start_or_resume",
      runId,
      purpose: "purchase_validation",
      eventId: started.run.dispatchEventId,
    });
    // Connect the browser only after the run has paused. The row exists
    // before the broker is consulted, so connecting on its first sight raced
    // the pause and let browser evidence join the still-open submission,
    // hiding how the agent settles a pending browser command.
    await waitForRun(
      runId,
      async () => {
        const [[operation], [run]] = await Promise.all([
          getDb(ctx.db)
            .select({ state: runOperation.state, result: runOperation.result })
            .from(runOperation)
            .where(
              and(
                eq(runOperation.runId, runId),
                eq(runOperation.kind, "browser_command"),
              ),
            )
            .limit(1),
          getDb(ctx.db)
            .select({ status: runTable.status })
            .from(runTable)
            .where(eq(runTable.id, runId)),
        ]);
        return (
          z.object({ commandId: z.uuid() }).safeParse(operation?.result)
            .success &&
          operation?.state === "completed" &&
          run?.status === "paused_offline"
        );
      },
      "Production service never paused for the browser command",
    );
    await scenario.connectBrowser({
      vendorAccountId: account.id,
      ledgerPartyId: party.id,
      userId: ctx.actor.userId,
    });
    await waitForRun(
      runId,
      async () => {
        const [run] = await getDb(ctx.db)
          .select({
            status: runTable.status,
            coordinatorStartedAt: runTable.coordinatorStartedAt,
          })
          .from(runTable)
          .where(eq(runTable.id, runId));
        return run?.status === "completed" && run.coordinatorStartedAt !== null;
      },
      "Production service never finalized targeted run",
    );
    expect(
      await protectedBusinessSnapshot(ctx.db, {
        purchaseId: targetPurchase.id,
        productId: targetProduct.entityId,
      }),
    ).toEqual(before);
    expect(await scenario.violations()).toEqual([]);
  }, 60_000);
});
