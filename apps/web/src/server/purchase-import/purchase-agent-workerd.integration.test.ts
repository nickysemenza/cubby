/* eslint-disable anti-slop/no-unsafe-dictionary-type -- The harness adapts generated Wrangler JSON whose binding dictionaries have no source-level owner type. */
import { importRunId, parseEntityId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { createWorkerdHarness } from "tooling/purchase-agent-workerd-harness";
import { type TestDbContext, withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHarness } from "wrangler";
import { z } from "zod";

import {
  aiUsage,
  auditLog,
  entityAttachment,
  expense,
  financialTransaction,
  financialTransactionAllocation,
  image,
  importFinding,
  importRun,
  importRunMutation,
  importRunOperation,
  importRunProgress,
  importRunTarget,
  importSourceClaim,
  oauthRefreshToken,
  product,
  photoGroupProposal,
  purchase,
  purchasePaymentEvidence,
  session,
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
  ensurePurchaseAgentOAuthClient,
  PURCHASE_AGENT_OAUTH_CLIENT_ID,
} from "./agent-auth";
import {
  startPhotoInventoryCoordinator,
  startPhotoInventoryRun,
  startTargetedImportRun,
} from "./run-service";

let harness: TestHarness | undefined;

async function waitFor(predicate: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function workerdDiagnostic(db: TestDbContext["db"], runId: string) {
  const [run, operations, findings, progress, proposals, usage] =
    await Promise.all([
      getDb(db)
        .select({
          status: importRun.status,
          failureCode: importRun.failureCode,
          dispatchError: importRun.dispatchError,
          dispatchAttempts: importRun.dispatchAttempts,
          coordinatorStartedAt: importRun.coordinatorStartedAt,
        })
        .from(importRun)
        .where(eq(importRun.id, importRunId.parse(runId))),
      getDb(db)
        .select({
          operationId: importRunOperation.operationId,
          kind: importRunOperation.kind,
          state: importRunOperation.state,
          result: importRunOperation.result,
          error: importRunOperation.error,
        })
        .from(importRunOperation)
        .where(eq(importRunOperation.runId, runId)),
      // The review reason lives on the finding and the last progress report,
      // not on the run row.
      getDb(db)
        .select({ kind: importFinding.kind, summary: importFinding.summary })
        .from(importFinding)
        .where(eq(importFinding.importRunId, runId)),
      getDb(db)
        .select({
          phase: importRunProgress.phase,
          detail: importRunProgress.detail,
        })
        .from(importRunProgress)
        .where(eq(importRunProgress.runId, runId)),
      getDb(db)
        .select({ state: photoGroupProposal.state })
        .from(photoGroupProposal)
        .where(eq(photoGroupProposal.runId, importRunId.parse(runId))),
      getDb(db)
        .select({ id: aiUsage.id })
        .from(aiUsage)
        .where(eq(aiUsage.runId, importRunId.parse(runId))),
    ]);
  return JSON.stringify({
    run,
    operations,
    findings,
    progress,
    proposals,
    usage,
    logs: harness?.getLogs(),
  });
}

async function protectedBusinessSnapshot(
  db: TestDbContext["db"],
  input: {
    purchaseId: typeof purchase.$inferSelect.id;
    productId: typeof product.$inferSelect.id;
    runId: string;
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
      .where(eq(entityAttachment.subjectEntityId, input.purchaseId)),
    database
      .select()
      .from(entityAttachment)
      .where(eq(entityAttachment.subjectEntityId, input.productId)),
    database.select().from(importSourceClaim),
    database.select().from(purchasePaymentEvidence),
    database.select().from(financialTransaction),
    database.select().from(financialTransactionAllocation),
    database.select().from(auditLog),
    database
      .select()
      .from(importRunMutation)
      .where(eq(importRunMutation.runId, input.runId)),
  ]);
  return JSON.stringify(values);
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("purchase-agent coupled two-Worker workerd harness", () => {
  const ctx = withTestDb();

  it("dispatches a photo run through Flue and MCP, waits for review, then commits only on approval", async () => {
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
      .insert(importRunTarget)
      .values({
        runId: importRunId.parse(run.id),
        imageId: parseEntityId("image", imageFixture.id),
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

    await ensurePurchaseAgentOAuthClient(ctx.db);
    const now = new Date();
    const sessionId = `photo-workerd-${crypto.randomUUID()}`;
    await getDb(ctx.db)
      .insert(session)
      .values({
        id: sessionId,
        token: `${sessionId}-token`,
        userId: ctx.actor.userId,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        updatedAt: now,
      });
    await getDb(ctx.db)
      .insert(oauthRefreshToken)
      .values({
        id: `${sessionId}-grant`,
        token: `${sessionId}-refresh`,
        clientId: PURCHASE_AGENT_OAUTH_CLIENT_ID,
        sessionId,
        userId: ctx.actor.userId,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        authTime: now,
        scopes: ["openid", "profile", "email", "offline_access"],
      });
    const productName = `Synthetic wardrobe item ${crypto.randomUUID()}`;
    const previousHyperdrive = new Map(
      [
        "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
        "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
      ].map((key) => [key, process.env[key]]),
    );
    for (const key of previousHyperdrive.keys())
      process.env[key] = ctx.databaseUrl;
    try {
      harness = createWorkerdHarness(ctx.databaseUrl);
      const { url } = await harness.listen();
      const model = harness.getWorker("cubby-test-model");
      expect(
        (
          await model.fetch("https://model.test/configure", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: "photo",
              runId: run.id,
              runShortcode: run.publicId,
              imageShortcode: imageFixture.shortcode,
              productName,
            }),
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await fetch(new URL("/dispatch", url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              version: 1,
              type: "start_or_resume",
              runId: run.id,
              // The persisted run, not a stale queue hint, selects the Flue workflow.
              purpose: "account_sync",
              eventId: started.eventId,
            }),
          })
        ).status,
      ).toBe(202);
      try {
        await waitFor(async () => {
          const [proposal, progress, startedProgress, usage] =
            await Promise.all([
              getDb(ctx.db)
                .select({ state: photoGroupProposal.state })
                .from(photoGroupProposal)
                .where(eq(photoGroupProposal.runId, run.id))
                .limit(1),
              getDb(ctx.db)
                .select({ phase: importRunProgress.phase })
                .from(importRunProgress)
                .where(
                  and(
                    eq(importRunProgress.runId, run.id),
                    eq(importRunProgress.phase, "awaiting_approval"),
                  ),
                )
                .limit(1),
              getDb(ctx.db)
                .select({ id: importRunProgress.id })
                .from(importRunProgress)
                .where(
                  and(
                    eq(importRunProgress.runId, run.id),
                    eq(importRunProgress.detail, "Coordinator started"),
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
        }, "Photo agent did not propose a group and wait for approval");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${await workerdDiagnostic(ctx.db, run.id)}`,
          { cause: error },
        );
      }
      expect(
        await getDb(ctx.db)
          .select({ id: product.id })
          .from(product)
          .where(eq(product.name, productName)),
      ).toHaveLength(0);
      const [waitingRun] = await getDb(ctx.db)
        .select({ status: importRun.status })
        .from(importRun)
        .where(eq(importRun.id, run.id));
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
        .select({ status: importRun.status })
        .from(importRun)
        .where(eq(importRun.id, run.id));
      expect(settled?.status).toBe("completed");
    } finally {
      for (const [key, value] of previousHyperdrive) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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
    await ensurePurchaseAgentOAuthClient(ctx.db);
    const now = new Date();
    const sessionId = "purchase-agent-workerd-session";
    await getDb(ctx.db)
      .insert(session)
      .values({
        id: sessionId,
        token: "purchase-agent-workerd-session-token",
        userId: ctx.actor.userId,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        updatedAt: now,
      });
    await getDb(ctx.db)
      .insert(oauthRefreshToken)
      .values({
        id: "purchase-agent-workerd-grant",
        token: "purchase-agent-workerd-refresh-token",
        clientId: PURCHASE_AGENT_OAUTH_CLIENT_ID,
        sessionId,
        userId: ctx.actor.userId,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        authTime: now,
        scopes: ["openid", "profile", "email", "offline_access"],
      });
    const sourceExternalKey = "workerd:ORDER-WORKERD-1";
    const evidenceChecksum = "a".repeat(64);
    const started = await startTargetedImportRun(ctx.db, {
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

    const before = await protectedBusinessSnapshot(ctx.db, {
      purchaseId: targetPurchase.id,
      productId: targetProduct.entityId,
      runId: started.run.id,
    });
    const previousHyperdrive = new Map(
      [
        "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
        "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_CACHED",
      ].map((key) => [key, process.env[key]]),
    );
    for (const key of previousHyperdrive.keys())
      process.env[key] = ctx.databaseUrl;
    try {
      harness = createWorkerdHarness(ctx.databaseUrl);
      const { url } = await harness.listen();
      const model = harness.getWorker("cubby-test-model");
      expect(
        (
          await model.fetch("https://model.test/configure", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              runId: started.run.id,
              productShortcode: targetProductRow.shortcode,
              sourceExternalKey,
              evidenceChecksum,
            }),
          })
        ).status,
      ).toBe(204);
      const dispatch = (event: Record<string, unknown>) =>
        fetch(new URL("/dispatch", url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        });
      const startEvent = {
        version: 1,
        type: "start_or_resume",
        runId: started.run.id,
        purpose: "purchase_validation",
        eventId: started.run.dispatchEventId,
      };
      expect((await dispatch(startEvent)).status).toBe(202);
      let browserCommand:
        | { commandId: string; operationId: string }
        | undefined;
      try {
        await waitFor(async () => {
          const [operation] = await getDb(ctx.db)
            .select({
              operationId: importRunOperation.operationId,
              result: importRunOperation.result,
            })
            .from(importRunOperation)
            .where(
              and(
                eq(importRunOperation.runId, started.run.id),
                eq(importRunOperation.kind, "browser_command"),
              ),
            )
            .limit(1);
          const parsed = z
            .object({ commandId: z.uuid() })
            .safeParse(operation?.result);
          browserCommand = parsed.success
            ? {
                commandId: parsed.data.commandId,
                operationId: operation?.operationId ?? "",
              }
            : undefined;
          return Boolean(browserCommand?.operationId);
        }, "Production service never persisted browser command");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${await workerdDiagnostic(ctx.db, started.run.id)}`,
          { cause: error },
        );
      }

      expect(
        (
          await fetch(new URL("/browser-result", url), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              vendorAccountId: account.id,
              ledgerPartyId: party.id,
              userId: ctx.actor.userId,
              runId: started.run.id,
              commandId: z.uuid().parse(browserCommand?.commandId),
              operationId: browserCommand?.operationId,
            }),
          })
        ).status,
      ).toBe(202);
      try {
        await waitFor(async () => {
          const [run] = await getDb(ctx.db)
            .select({
              status: importRun.status,
              coordinatorStartedAt: importRun.coordinatorStartedAt,
            })
            .from(importRun)
            .where(eq(importRun.id, started.run.id));
          return (
            run?.status === "completed" && run.coordinatorStartedAt !== null
          );
        }, "Production service never finalized targeted run");
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${await workerdDiagnostic(ctx.db, started.run.id)}`,
          { cause: error },
        );
      }
      const after = await protectedBusinessSnapshot(ctx.db, {
        purchaseId: targetPurchase.id,
        productId: targetProduct.entityId,
        runId: started.run.id,
      });
      expect(after).toEqual(before);
    } finally {
      for (const [key, value] of previousHyperdrive) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 60_000);
});
