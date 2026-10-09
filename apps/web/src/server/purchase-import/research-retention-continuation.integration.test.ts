import { runEntityId, userId } from "@cubby/schemas/identifiers";
import { MAILBOX_RESEARCH_VERSION } from "@cubby/schemas/mailbox-research";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import {
  mailResearchRunInput,
  purchaseValidationResearchRunInput,
} from "@cubby/schemas/run-fields";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  mailboxMessage,
  image,
  importHunt,
  financialTransactionAllocation,
  orderMail,
  researchRetention,
  run,
  runTarget,
  runEvidence,
  vendorAccount,
  purchase,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  getDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createImageFixture } from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import * as s3 from "~/server/utils/s3";

import { startProductResearch } from "./product-research-run";
import { productResearchFixture } from "./product-research.fixtures";
import { startPurchaseValidationResearch } from "./purchase-validation-research";
import { submitReceiptEvidence } from "./receipt-evidence";
import { startRetiredObjectiveResearch } from "./research-objective-admission";
import {
  exposeResearchSources,
  requestResearchRetention,
} from "./research-retention";
import { processBoundResearchRetention } from "./research-retention-runtime";
import { startMailResearch } from "./research-run";
import { startOrResumeRun } from "./run-service";

// Retirement cannot reopen settled targets or reuse destroyed coordinators.
// Unchanged remaining sources need fresh, replayable admission; only the owning
// cleanup receipt may bypass the normal unchanged-source research deduplication.
describe("retired research successor admission", () => {
  const ctx = withTestDb();
  async function fixture(includeSurvivor = false) {
    const f = await productResearchFixture(ctx.db, ctx.actor);
    const events: PurchaseAgentEvent[] = [];
    const queue = {
      send: async (event: PurchaseAgentEvent) => {
        events.push(event);
      },
    };
    const sources = [];
    const names = includeSurvivor
      ? ["unrelated", "remaining", "surviving"]
      : ["unrelated", "remaining"];
    for (const name of names) {
      const checksum = await sha256Hex(`Synthetic ${name} message`);
      const [source] = await getDb(ctx.db)
        .insert(orderMail)
        .values({
          ledgerPartyId: f.party.id,
          mailboxId: "synthetic-successor-mailbox",
          messageId: `synthetic-${name}`,
          sender: "orders@example.test",
          subject: `Synthetic ${name} message`,
          receivedAt: new Date("2026-10-01T00:00:00Z"),
          rawChecksum: checksum,
          content: {
            snippet: null,
            bodyText: `Synthetic ${name} message`,
            bodyHtml: null,
          },
        })
        .returning();
      if (!source) throw new Error("Synthetic retained source missing");
      sources.push(source);
      await getDb(ctx.db).insert(mailboxMessage).values({
        ledgerPartyId: f.party.id,
        mailboxId: source.mailboxId,
        messageId: source.messageId,
        checksum,
        classification: "related",
        classificationVersion: MAILBOX_RESEARCH_VERSION,
        status: "pending",
        orderMailId: source.id,
      });
    }
    const [primary, remaining] = sources;
    if (!primary || !remaining)
      throw new Error("Synthetic source batch missing");
    const [mailRun] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        mailboxId: primary.mailboxId,
        messageIds: sources.map((source) => source.id),
      },
      queue,
    );
    if (!mailRun) throw new Error("Synthetic mail Run missing");
    const [primaryTarget] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(
        and(
          eq(runTarget.runId, runEntityId.parse(mailRun.runId)),
          eq(runTarget.workKey, primary.id),
        ),
      );
    if (!primaryTarget) throw new Error("Synthetic primary work missing");
    const retire = async (source = primary, disposed = true) => {
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(
          and(
            eq(runTarget.runId, runEntityId.parse(mailRun.runId)),
            eq(runTarget.workKey, source.id),
          ),
        );
      if (!target) throw new Error("Synthetic retirement work missing.");
      const receipt = await requestResearchRetention(ctx.db, {
        runId: mailRun.runId,
        workRef: target.id,
        callId: `synthetic-unrelated-resolution:${source.messageId}`,
        hasSupportedWrites: false,
      });
      // Admission starts at the persisted boundary after external disposal. Its
      // public SDK acknowledgement is tested separately against the real Worker.
      if (disposed)
        await getDb(ctx.db)
          .update(researchRetention)
          .set({ phase: "coordinators_destroyed" })
          .where(eq(researchRetention.id, receipt.receiptId));
      return receipt;
    };
    return {
      ...f,
      queue,
      events,
      primary,
      remaining,
      surviving: sources[2],
      mailRun,
      retire,
    };
  }
  it.each(["primary_first", "remaining_first"] as const)(
    "finishes overlapping fenced receipts after shared screenshot rows are erased (%s)",
    async (ordering) => {
      const f = await fixture();
      if (!f.order.vendorId)
        throw new Error("Synthetic browser Vendor missing.");
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        vendorId: f.order.vendorId,
        ledgerPartyId: f.party.id,
        label: "Synthetic overlap browser",
        browserSyncEnabled: true,
      });
      const photo = await createImageFixture(
        ctx.db,
        "independently-owned-overlap-photo",
      );
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, runEntityId.parse(f.mailRun.runId)));
      if (!target) throw new Error("Synthetic capture work missing.");
      const [binary] = await getDb(ctx.db)
        .insert(runEvidence)
        .values({
          runId: runEntityId.parse(f.mailRun.runId),
          targetId: target.id,
          kind: "browser_capture",
          objectKey: "synthetic-overlap/screenshot.png",
          checksum: await sha256Hex(
            "Synthetic disposable overlap screenshot bytes",
          ),
          mediaType: "image/png",
          sourceMetadata: { brokerAccountId: account.id },
        })
        .returning();
      if (!binary) throw new Error("Synthetic screenshot evidence missing.");
      await getDb(ctx.db)
        .insert(runEvidence)
        .values({
          runId: binary.runId,
          targetId: target.id,
          kind: "browser_capture",
          objectKey: "synthetic-overlap/capture.html",
          checksum: await sha256Hex(
            "Synthetic disposable overlap capture HTML",
          ),
          mediaType: "text/html",
          sourceMetadata: {
            brokerAccountId: account.id,
            screenshots: [
              {
                id: binary.id,
                kind: "screenshot",
                checksum: binary.checksum,
                contentType: "image/png",
              },
            ],
          },
        });
      const receipts = [
        await f.retire(f.primary, false),
        await f.retire(f.remaining, false),
      ];
      if (ordering === "remaining_first") receipts.reverse();
      const objects = new Set([
        binary.objectKey,
        "synthetic-overlap/capture.html",
        photo.key,
      ]);
      const deletion = vi
        .spyOn(s3, "deleteS3Object")
        .mockImplementation(async (key) => {
          objects.delete(key);
        });
      const env = fromPartial<Env>({
        PURCHASE_IMPORT: {
          getByName: () => ({ forgetRun: async () => ({ forgotten: true }) }),
        },
        PURCHASE_IMPORT_RUN: {
          getByName: () => ({ retire: async () => ({ disposed: true }) }),
        },
        PURCHASE_AGENT_QUEUE: {
          send: async (event: PurchaseAgentEvent) => {
            f.events.push(purchaseAgentEvent.parse(event));
          },
        },
      });
      try {
        for (const receipt of receipts) {
          expect(
            await processBoundResearchRetention(ctx.db, env, {
              runId: f.mailRun.runId,
              receiptId: receipt.receiptId,
            }),
          ).toEqual({ completed: true });
          expect(
            await getDb(ctx.db)
              .select()
              .from(runEvidence)
              .where(eq(runEvidence.runId, binary.runId)),
          ).toEqual([]);
        }
        expect(objects).toEqual(new Set([photo.key]));
        expect(
          await getDb(ctx.db)
            .select()
            .from(image)
            .where(eq(image.id, photo.id)),
        ).toMatchObject([{ id: photo.id, key: photo.key }]);
      } finally {
        deletion.mockRestore();
      }
    },
  );
  it("rechecks source retirement at mail admission after the caller selected its continuation", async () => {
    const f = await fixture(true);
    if (!f.surviving) throw new Error("Synthetic surviving source missing.");
    const first = await f.retire();
    const selected = [f.remaining, f.surviving];
    await f.retire(f.remaining);
    const [admitted] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        mailboxId: f.primary.mailboxId,
        messageIds: selected.map((source) => source.id),
        expectedChecksums: selected.map((source) => ({
          orderMailId: source.id,
          checksum: source.rawChecksum,
        })),
        parentRunId: runEntityId.parse(f.mailRun.runId),
        retirementReceiptId: first.receiptId,
      },
      f.queue,
    );
    if (!admitted) throw new Error("Supported unfinished mail was lost.");
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(admitted.runId)));
    expect(mailResearchRunInput.parse(saved?.input).sources).toEqual([
      { orderMailId: f.surviving.id, checksum: f.surviving.rawChecksum },
    ]);
    const tasks = await getDb(ctx.db)
      .select({ workKey: runTarget.workKey })
      .from(runTarget)
      .where(eq(runTarget.runId, runEntityId.parse(admitted.runId)));
    expect(tasks).toEqual([{ workKey: f.surviving.id }]);
  });
  it("creates one fresh Product successor for unchanged unfinished work and replays its admission", async () => {
    const f = await fixture();
    const input = {
      ledgerPartyId: f.party.id,
      userId: userId.parse(ctx.actor.userId),
      productIds: [f.item.entityId],
      parentRunId: runEntityId.parse(f.mailRun.runId),
    };
    const [original] = await startProductResearch(ctx.db, input, f.queue);
    if (!original) throw new Error("Synthetic Product research missing");
    await exposeResearchSources(ctx.db, {
      runId: original.runId,
      sources: [{ orderMailId: f.primary.id, checksum: f.primary.rawChecksum }],
    });
    const receipt = await f.retire();
    const retry = {
      ...input,
      parentRunId: original.runId,
      retirementReceiptId: receipt.receiptId,
    };
    const [successor] = await startProductResearch(ctx.db, retry, f.queue);
    expect(successor).toBeDefined();
    if (!successor)
      throw new Error("Unfinished Product was lost after retirement");
    expect(successor.runId).not.toBe(original.runId);
    expect(await startProductResearch(ctx.db, retry, f.queue)).toMatchObject([
      { runId: successor.runId, created: false },
    ]);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, successor.runId));
    expect(saved).toMatchObject({
      parentRunId: f.mailRun.runId,
      predecessorRunId: original.runId,
      cause: "retry",
      attempt: 2,
      retiredAt: null,
    });
    const [oldTarget] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, original.runId));
    expect(oldTarget?.state).toBe("pending");
  });
  it.each([1, null])(
    "transfers unfinished Purchase validation through its disposed source receipt with attempt %s",
    async (attempt) => {
      const f = await fixture();
      const original = await startPurchaseValidationResearch(
        ctx.db,
        {
          ledgerPartyId: f.party.id,
          userId: ctx.actor.userId,
          purchaseIds: [f.order.id],
        },
        f.queue,
      );
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, original.row.id));
      if (!target) throw new Error("Synthetic Purchase validation missing.");
      expect(target).toMatchObject({
        entityKind: "purchase",
        entityId: f.order.id,
        state: "needs_evidence",
      });
      await getDb(ctx.db)
        .update(run)
        .set({ attempt })
        .where(eq(run.id, original.row.id));
      await exposeResearchSources(ctx.db, {
        runId: original.row.id,
        sources: [
          { orderMailId: f.primary.id, checksum: f.primary.rawChecksum },
        ],
      });
      const receipt = await f.retire(f.primary, false);
      expect(receipt.retiredRunIds).toContain(original.row.id);
      // A new task must describe current Purchase state, never the retired model context.
      await getDb(ctx.db)
        .update(purchase)
        .set({ date: "2026-09-02" })
        .where(eq(purchase.id, f.order.id));
      const env = fromPartial<Env>({
        PURCHASE_IMPORT: {
          getByName: () => ({ forgetRun: async () => ({ forgotten: true }) }),
        },
        PURCHASE_IMPORT_RUN: {
          getByName: () => ({ retire: async () => ({ disposed: true }) }),
        },
        PURCHASE_AGENT_QUEUE: f.queue,
      });
      const deletion = vi.spyOn(s3, "deleteS3Object").mockResolvedValue();
      try {
        const input = {
          runId: f.mailRun.runId,
          receiptId: receipt.receiptId,
        };
        expect(await processBoundResearchRetention(ctx.db, env, input)).toEqual(
          {
            completed: true,
          },
        );
        expect(await processBoundResearchRetention(ctx.db, env, input)).toEqual(
          {
            completed: true,
          },
        );
      } finally {
        deletion.mockRestore();
      }
      const successors = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, original.row.id));
      expect(successors).toHaveLength(1);
      const successor = successors[0]!;
      expect(successor).toMatchObject({
        ledgerPartyId: f.party.id,
        actorUserId: ctx.actor.userId,
        purpose: "purchase_validation",
        cause: "retry",
        parentRunId: null,
        attempt: attempt === null ? null : attempt + 1,
        retiredAt: null,
      });
      const saved = purchaseValidationResearchRunInput.parse(successor.input);
      expect(saved.purchases).toHaveLength(1);
      expect(saved.purchases[0]).toMatchObject({
        purchaseId: f.order.id,
        selectedSource: null,
        manualEvidenceUnavailable: false,
      });
      expect(saved.purchases[0]?.contextFingerprint).not.toBe(
        target.targetFingerprint,
      );
      const tasks = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, successor.id));
      expect(tasks).toMatchObject([
        {
          entityKind: "purchase",
          entityId: f.order.id,
          state: "needs_evidence",
          targetFingerprint: saved.purchases[0]?.contextFingerprint,
        },
      ]);
      expect(
        f.events.filter((event) => event.runId === successor.id),
      ).toHaveLength(1);
      expect(
        await getDb(ctx.db)
          .select()
          .from(purchase)
          .where(eq(purchase.id, f.order.id)),
      ).toMatchObject([{ id: f.order.id, date: "2026-09-02" }]);
    },
  );
  async function retiredValidationFixture(twoPurchases = false) {
    const f = await fixture();
    const second = twoPurchases
      ? await insertWithShortcode(ctx.db, "purchase", {
          vendorId: f.order.vendorId,
          orderId: "SYNTHETIC-SECOND-PURCHASE",
          date: "2026-09-01",
        })
      : null;
    const original = await startPurchaseValidationResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        purchaseIds: [f.order.id, ...(second ? [second.id] : [])],
      },
      f.queue,
    );
    await exposeResearchSources(ctx.db, {
      runId: original.row.id,
      sources: [{ orderMailId: f.primary.id, checksum: f.primary.rawChecksum }],
    });
    const receipt = await f.retire(f.primary, false);
    const env = fromPartial<Env>({
      PURCHASE_IMPORT: {
        getByName: () => ({ forgetRun: async () => ({ forgotten: true }) }),
      },
      PURCHASE_IMPORT_RUN: {
        getByName: () => ({ retire: async () => ({ disposed: true }) }),
      },
      PURCHASE_AGENT_QUEUE: f.queue,
    });
    return { ...f, original, receipt, env };
  }
  it.each([false, true])(
    "refuses retirement when the frozen Purchase roster is incomplete (remaining sibling %s)",
    async (twoPurchases) => {
      const f = await retiredValidationFixture(twoPurchases);
      await getDb(ctx.db)
        .delete(runTarget)
        .where(
          and(
            eq(runTarget.runId, f.original.row.id),
            eq(runTarget.entityId, f.order.id),
          ),
        );
      const deletion = vi.spyOn(s3, "deleteS3Object").mockResolvedValue();
      try {
        await expect(
          processBoundResearchRetention(ctx.db, f.env, {
            runId: f.mailRun.runId,
            receiptId: f.receipt.receiptId,
          }),
        ).rejects.toThrow(/task admission/);
      } finally {
        deletion.mockRestore();
      }
      expect(
        await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.predecessorRunId, f.original.row.id)),
      ).toEqual([]);
      expect(
        await getDb(ctx.db)
          .select({ phase: researchRetention.phase })
          .from(researchRetention)
          .where(eq(researchRetention.id, f.receipt.receiptId)),
      ).toEqual([{ phase: "coordinators_destroyed" }]);
    },
  );
  it("redelivers an admitted Purchase successor after its producer failed using the same event", async () => {
    const f = await retiredValidationFixture();
    const attempts: PurchaseAgentEvent[] = [];
    const env = {
      ...f.env,
      PURCHASE_AGENT_QUEUE: {
        send: async (event: PurchaseAgentEvent) => {
          if (event.purpose === "purchase_validation") {
            attempts.push(event);
            if (attempts.length === 1)
              throw new Error("Synthetic Purchase producer interruption");
          }
          await f.queue.send(event);
        },
      },
    };
    const input = { runId: f.mailRun.runId, receiptId: f.receipt.receiptId };
    const deletion = vi.spyOn(s3, "deleteS3Object").mockResolvedValue();
    try {
      await expect(
        processBoundResearchRetention(ctx.db, env, input),
      ).rejects.toThrow(/Synthetic Purchase producer interruption/);
      const [before] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, f.original.row.id));
      expect(before).toMatchObject({
        status: "dispatch_failed",
        dispatchAttempts: 1,
      });
      expect(await processBoundResearchRetention(ctx.db, env, input)).toEqual({
        completed: true,
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(attempts[0]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.predecessorRunId, f.original.row.id)),
      ).toMatchObject([
        {
          id: before?.id,
          status: "running",
          dispatchAttempts: 2,
          dispatchError: null,
        },
      ]);
      expect(await processBoundResearchRetention(ctx.db, env, input)).toEqual({
        completed: true,
      });
      expect(attempts).toHaveLength(2);
    } finally {
      deletion.mockRestore();
    }
  });
  it.each(["primary-first", "remaining-first"])(
    "preserves a cancelled Product continuation across overlapping source receipts (%s)",
    async (order) => {
      const f = await fixture();
      const input = {
        ledgerPartyId: f.party.id,
        userId: userId.parse(ctx.actor.userId),
        productIds: [f.item.entityId],
        parentRunId: runEntityId.parse(f.mailRun.runId),
      };
      const [original] = await startProductResearch(ctx.db, input, f.queue);
      if (!original) throw new Error("Synthetic Product research missing");
      await exposeResearchSources(ctx.db, {
        runId: original.runId,
        sources: [f.primary, f.remaining].map((source) => ({
          orderMailId: source.id,
          checksum: source.rawChecksum,
        })),
      });
      const primaryReceipt = await f.retire();
      const [remainingTarget] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(
          and(
            eq(runTarget.runId, runEntityId.parse(f.mailRun.runId)),
            eq(runTarget.workKey, f.remaining.id),
          ),
        );
      if (!remainingTarget)
        throw new Error("Synthetic second source task missing");
      const remainingReceipt = await requestResearchRetention(ctx.db, {
        runId: f.mailRun.runId,
        workRef: remainingTarget.id,
        callId: "synthetic-second-source-retirement",
        hasSupportedWrites: false,
      });
      await getDb(ctx.db)
        .update(researchRetention)
        .set({ phase: "coordinators_destroyed" })
        .where(eq(researchRetention.id, remainingReceipt.receiptId));
      expect(primaryReceipt.retiredRunIds).toContain(original.runId);
      expect(remainingReceipt.retiredRunIds).toContain(original.runId);
      const receipts =
        order === "primary-first"
          ? [primaryReceipt, remainingReceipt]
          : [remainingReceipt, primaryReceipt];
      const admitted: Awaited<ReturnType<typeof startProductResearch>> = [];
      for (const receipt of receipts) {
        const [successor] = await startProductResearch(
          ctx.db,
          {
            ...input,
            parentRunId: original.runId,
            retirementReceiptId: receipt.receiptId,
          },
          f.queue,
        );
        if (!successor)
          throw new Error("Synthetic unfinished continuation missing");
        admitted.push(successor);
        if (admitted.length === 1) {
          await getDb(ctx.db)
            .update(run)
            .set({
              status: "failed",
              failureCode: "user_cancelled",
              endedAt: new Date(),
            })
            .where(eq(run.id, runEntityId.parse(successor.runId)));
        }
      }
      expect(admitted[1]).toMatchObject({
        runId: admitted[0]!.runId,
        created: false,
      });
      const successors = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, runEntityId.parse(original.runId)));
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({
        parentRunId: f.mailRun.runId,
        cause: "retry",
        attempt: 2,
        retiredAt: null,
        status: "failed",
        failureCode: "user_cancelled",
      });
      expect(
        f.events.filter((event) => event.runId === admitted[0]!.runId),
      ).toHaveLength(1);
    },
  );
  it("moves remaining mail to one fresh Run and recovers a failed producer without resurrecting its predecessor", async () => {
    const f = await fixture();
    const receipt = await f.retire();
    const retry = {
      ledgerPartyId: f.party.id,
      userId: ctx.actor.userId,
      mailboxId: f.remaining.mailboxId,
      messageIds: [f.remaining.id],
      parentRunId: runEntityId.parse(f.mailRun.runId),
      retirementReceiptId: receipt.receiptId,
    };
    const [failed] = await startMailResearch(ctx.db, retry, {
      send: async () => {
        throw new Error("Synthetic successor producer unavailable");
      },
    });
    expect(failed?.status).toBe("dispatch_failed");
    if (!failed) throw new Error("Unfinished mail was lost after retirement");
    expect(failed.runId).not.toBe(f.mailRun.runId);
    const [recovered] = await startMailResearch(ctx.db, retry, f.queue);
    expect(recovered).toMatchObject({ runId: failed.runId, status: "running" });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(failed.runId)));
    expect(saved).toMatchObject({
      parentRunId: null,
      predecessorRunId: f.mailRun.runId,
      cause: "retry",
      attempt: 2,
      retiredAt: null,
    });
  });
  it.each([
    "same_receipt",
    "outside_receipt",
    "changed_owner_scope",
    "earlier_receipt",
    "earlier_missing_work",
  ])(
    "preserves canonical mail dispositions when an older exposed Run is cleaned first (%s)",
    async (mode) => {
      const f = await fixture(true);
      if (!f.surviving) throw new Error("Synthetic surviving source missing.");
      const [otherUnrelated] = mode.startsWith("earlier")
        ? await getDb(ctx.db)
            .insert(orderMail)
            .values({
              ledgerPartyId: f.party.id,
              mailboxId: f.primary.mailboxId,
              messageId: "synthetic-canonical-only-unrelated",
              sender: "orders@example.test",
              subject: "Synthetic canonical-only unrelated message",
              receivedAt: new Date("2026-10-01T00:00:00Z"),
              rawChecksum: await sha256Hex("Synthetic other unrelated message"),
              content: {
                snippet: null,
                bodyText: "Synthetic other unrelated message",
                bodyHtml: null,
              },
            })
            .returning()
        : [];
      // An older failed investigation may retain pending descriptors after
      // discovery assigns its originals to a different frozen batch.
      await getDb(ctx.db)
        .update(run)
        .set({ status: "failed", failureCode: "model_error" })
        .where(eq(run.id, runEntityId.parse(f.mailRun.runId)));
      await getDb(ctx.db)
        .update(mailboxMessage)
        .set({ runId: null, status: "pending" })
        .where(
          and(
            eq(mailboxMessage.ledgerPartyId, f.party.id),
            inArray(mailboxMessage.orderMailId, [
              f.remaining.id,
              f.surviving.id,
            ]),
          ),
        );
      const [canonical] = await startMailResearch(
        ctx.db,
        {
          ledgerPartyId: f.party.id,
          userId: ctx.actor.userId,
          messageIds: [
            f.remaining.id,
            f.surviving.id,
            ...(otherUnrelated ? [otherUnrelated.id] : []),
          ],
        },
        f.queue,
      );
      if (!canonical) throw new Error("Synthetic canonical owner missing.");
      const canonicalId = runEntityId.parse(canonical.runId);
      await exposeResearchSources(ctx.db, {
        runId: canonical.runId,
        sources: [
          { orderMailId: f.primary.id, checksum: f.primary.rawChecksum },
        ],
      });
      await getDb(ctx.db)
        .update(runTarget)
        .set({ state: "unresolved", outcome: "ambiguous" })
        .where(
          and(
            eq(runTarget.runId, canonicalId),
            eq(runTarget.workKey, f.remaining.id),
          ),
        );
      await getDb(ctx.db)
        .update(mailboxMessage)
        .set({ status: "blocked" })
        .where(eq(mailboxMessage.orderMailId, f.remaining.id));
      await getDb(ctx.db)
        .update(run)
        .set({ status: "needs_review" })
        .where(eq(run.id, canonicalId));
      const receipt = await f.retire();
      expect(receipt.retiredRunIds).toContain(canonical.runId);
      const [savedReceipt] = await getDb(ctx.db)
        .select()
        .from(researchRetention)
        .where(eq(researchRetention.id, receipt.receiptId));
      if (!savedReceipt) throw new Error("Synthetic cleanup receipt missing.");
      await getDb(ctx.db)
        .update(researchRetention)
        .set({
          plan: {
            ...savedReceipt.plan,
            retiredRunIds:
              mode !== "outside_receipt"
                ? [runEntityId.parse(f.mailRun.runId), canonicalId]
                : [runEntityId.parse(f.mailRun.runId)],
          },
        })
        .where(eq(researchRetention.id, receipt.receiptId));
      if (mode === "changed_owner_scope")
        await getDb(ctx.db)
          .update(run)
          .set({
            input: mailResearchRunInput.parse({
              kind: "mail_research",
              sources: [
                {
                  orderMailId: f.surviving.id,
                  checksum: f.surviving.rawChecksum,
                },
              ],
            }),
          })
          .where(eq(run.id, canonicalId));
      const input = { runId: f.mailRun.runId, receiptId: receipt.receiptId };
      const env = fromPartial<Env>({
        PURCHASE_IMPORT: {
          getByName: () => ({ forgetRun: async () => ({ forgotten: true }) }),
        },
        PURCHASE_IMPORT_RUN: {
          getByName: () => ({ retire: async () => ({ disposed: true }) }),
        },
        PURCHASE_AGENT_QUEUE: f.queue,
      });
      const deletion = vi.spyOn(s3, "deleteS3Object").mockResolvedValue();
      try {
        if (otherUnrelated) {
          const [otherTarget] = await getDb(ctx.db)
            .select()
            .from(runTarget)
            .where(
              and(
                eq(runTarget.runId, canonicalId),
                eq(runTarget.workKey, otherUnrelated.id),
              ),
            );
          if (!otherTarget)
            throw new Error("Synthetic other primary work missing.");
          const earlier = await requestResearchRetention(ctx.db, {
            runId: canonicalId,
            workRef: otherTarget.id,
            callId: "synthetic-canonical-only-retirement",
            hasSupportedWrites: false,
          });
          // The other receipt may finish while the first receipt still awaits the older Run.
          // oxlint-disable-next-line vitest/no-conditional-expect
          expect(
            await processBoundResearchRetention(ctx.db, env, {
              runId: canonicalId,
              receiptId: earlier.receiptId,
            }),
          ).toEqual({ completed: true });
          if (mode === "earlier_missing_work")
            await getDb(ctx.db)
              .delete(runTarget)
              .where(
                and(
                  eq(runTarget.runId, canonicalId),
                  eq(runTarget.workKey, f.remaining.id),
                ),
              );
        }
        if (
          mode === "outside_receipt" ||
          mode === "changed_owner_scope" ||
          mode === "earlier_missing_work"
        ) {
          // These negative admission modes must fail before any disposition is recorded.
          // oxlint-disable-next-line vitest/no-conditional-expect
          await expect(
            processBoundResearchRetention(ctx.db, env, input),
          ).rejects.toThrow(/ownership/iu);
          return;
        }
        expect(await processBoundResearchRetention(ctx.db, env, input)).toEqual(
          {
            completed: true,
          },
        );
        expect(await processBoundResearchRetention(ctx.db, env, input)).toEqual(
          {
            completed: true,
          },
        );
        const successors = await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.predecessorRunId, canonicalId));
        expect(successors).toHaveLength(1);
        const successor = successors[0]!;
        expect(mailResearchRunInput.parse(successor.input).sources).toEqual([
          { orderMailId: f.surviving.id, checksum: f.surviving.rawChecksum },
        ]);
        expect(
          await getDb(ctx.db)
            .select()
            .from(run)
            .where(
              eq(run.predecessorRunId, runEntityId.parse(f.mailRun.runId)),
            ),
        ).toEqual([]);
        const messages = await getDb(ctx.db)
          .select()
          .from(mailboxMessage)
          .where(eq(mailboxMessage.ledgerPartyId, f.party.id));
        expect(
          messages.find((m) => m.orderMailId === f.remaining.id),
        ).toMatchObject({
          runId: canonical.runId,
          status: "blocked",
        });
        expect(
          messages.find((m) => m.orderMailId === f.surviving!.id),
        ).toMatchObject({
          runId: successor.id,
          status: "researching",
        });
        expect(
          f.events.filter((event) => event.runId === successor.id),
        ).toHaveLength(1);
      } finally {
        deletion.mockRestore();
      }
    },
  );
  it("refuses an invented retirement receipt before borrowing the retired mail owner", async () => {
    const f = await fixture();
    await f.retire();
    await expect(
      startMailResearch(
        ctx.db,
        {
          ledgerPartyId: f.party.id,
          userId: ctx.actor.userId,
          mailboxId: f.remaining.mailboxId,
          messageIds: [f.remaining.id],
          parentRunId: runEntityId.parse(f.mailRun.runId),
          retirementReceiptId: crypto.randomUUID(),
        },
        f.queue,
      ),
    ).rejects.toThrow(/retirement|receipt/iu);
  });
  it("preserves an unknown historical attempt count in a retired mail successor", async () => {
    const f = await fixture();
    await getDb(ctx.db)
      .update(run)
      .set({ attempt: null })
      .where(eq(run.id, runEntityId.parse(f.mailRun.runId)));
    const receipt = await f.retire();
    const [successor] = await startMailResearch(
      ctx.db,
      {
        ledgerPartyId: f.party.id,
        userId: ctx.actor.userId,
        mailboxId: f.remaining.mailboxId,
        messageIds: [f.remaining.id],
        parentRunId: runEntityId.parse(f.mailRun.runId),
        retirementReceiptId: receipt.receiptId,
      },
      f.queue,
    );
    if (!successor) throw new Error("Synthetic historical successor missing.");
    const [saved] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runEntityId.parse(successor.runId)));
    expect(saved).toMatchObject({
      predecessorRunId: f.mailRun.runId,
      cause: "retry",
      attempt: null,
    });
  });
  async function retiredAccountFixture() {
    const f = await fixture();
    if (!f.order.vendorId) throw new Error("Synthetic history Vendor missing.");
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      vendorId: f.order.vendorId,
      ledgerPartyId: f.party.id,
      label: "Synthetic retired admission account",
      browserSyncEnabled: true,
    });
    const original = await startOrResumeRun(ctx.db, {
      ledgerPartyId: f.party.id,
      vendorAccountId: account.id,
      trigger: "backfill",
      backfill: { from: "2026-08-01", to: "2026-09-30" },
    });
    await exposeResearchSources(ctx.db, {
      runId: original.id,
      sources: [{ orderMailId: f.primary.id, checksum: f.primary.rawChecksum }],
    });
    const receipt = await f.retire();
    return { f, account, original, receipt };
  }
  async function retiredReceiptFixture() {
    const f = await fixture();
    const account = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Synthetic retired receipt card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: f.party.id,
    });
    const charge = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      amount: 12.34,
      transactionDate: "2026-09-21",
      postedDate: "2026-09-21",
    });
    const [hunt] = await getDb(ctx.db)
      .insert(importHunt)
      .values({
        ledgerPartyId: f.party.id,
        financialTransactionId: charge.id,
        state: "receipt_required",
        dateFrom: "2026-09-14",
        dateTo: "2026-09-28",
      })
      .returning();
    if (!hunt) throw new Error("Synthetic retired receipt hunt missing.");
    const photo = await insertWithShortcode(ctx.db, "image", {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "synthetic-receipt.jpg",
      contentType: "image/jpeg",
      size: 1024,
      status: "UPLOADED",
      sha256: "a".repeat(64),
    });
    await submitReceiptEvidence(
      ctx.db,
      { huntId: hunt.id, imageId: photo.shortcode },
      ctx.actor,
      f.queue,
    );
    const [claimed] = await getDb(ctx.db)
      .select()
      .from(importHunt)
      .where(eq(importHunt.id, hunt.id));
    if (!claimed?.receiptRunId)
      throw new Error("Synthetic retired receipt Run missing.");
    const originalId = runEntityId.parse(claimed.receiptRunId);
    await exposeResearchSources(ctx.db, {
      runId: originalId,
      sources: [{ orderMailId: f.primary.id, checksum: f.primary.rawChecksum }],
    });
    const receipt = await f.retire();
    return { f, hunt, charge, originalId, receipt };
  }
  it("takes retired objective account admission before locking its predecessor", async () => {
    const { f, account, original, receipt } = await retiredAccountFixture();
    let admission: ReturnType<typeof startRetiredObjectiveResearch> | undefined;
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${account.id}))`,
        );
        admission = startRetiredObjectiveResearch(
          ctx.db,
          {
            predecessorRunId: original.id,
            receiptId: receipt.receiptId,
            ledgerPartyId: f.party.id,
            actorUserId: ctx.actor.userId,
          },
          f.queue,
        );
        await vi.waitFor(
          async () => {
            const result = await getDb(ctx.db).execute(sql`SELECT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
              AND objid::bigint = (hashtext(${account.id})::bigint & 4294967295)
          ) AS waiting`);
            expect(
              z.object({ waiting: z.boolean() }).parse(result.rows[0]).waiting,
            ).toBe(true);
          },
          { interval: 20, timeout: 5_000 },
        );
        await tx.execute(
          sql`SELECT "id" FROM "Run" WHERE "id" = ${original.id} FOR NO KEY UPDATE NOWAIT`,
        );
      });
    } finally {
      if (admission) await admission;
    }
  });
  it("takes retired receipt hunt admission before locking its predecessor", async () => {
    const { f, hunt, originalId, receipt } = await retiredReceiptFixture();
    let admission: ReturnType<typeof startRetiredObjectiveResearch> | undefined;
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx.execute(
          sql`SELECT "id" FROM "ImportHunt" WHERE "id" = ${hunt.id} FOR UPDATE`,
        );
        admission = startRetiredObjectiveResearch(
          ctx.db,
          {
            predecessorRunId: originalId,
            receiptId: receipt.receiptId,
            ledgerPartyId: f.party.id,
            actorUserId: ctx.actor.userId,
          },
          f.queue,
        );
        await vi.waitFor(
          async () => {
            const result = await getDb(ctx.db).execute(sql`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
              AND query LIKE '%"ImportHunt"%' AND pid <> pg_backend_pid()
          ) AS waiting`);
            expect(
              z.object({ waiting: z.boolean() }).parse(result.rows[0]).waiting,
            ).toBe(true);
          },
          { interval: 20, timeout: 5_000 },
        );
        await tx.execute(
          sql`SELECT "id" FROM "Run" WHERE "id" = ${originalId} FOR NO KEY UPDATE NOWAIT`,
        );
      });
    } finally {
      if (admission) await admission;
    }
  });
  it.each([
    { child: "cancelled", accountChange: "newer" },
    { child: "removed", accountChange: "removed" },
  ] as const)(
    "replays the $child objective successor after its account is $accountChange",
    async ({ child, accountChange }) => {
      const { f, account, original, receipt } = await retiredAccountFixture();
      const input = {
        predecessorRunId: original.id,
        receiptId: receipt.receiptId,
        ledgerPartyId: f.party.id,
        actorUserId: ctx.actor.userId,
      };
      const successor = await startRetiredObjectiveResearch(
        ctx.db,
        input,
        f.queue,
      );
      if (!successor) throw new Error("Synthetic objective successor missing.");
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "failed",
          failureCode: "user_cancelled",
          deletedAt: child === "removed" ? new Date() : null,
        })
        .where(eq(run.id, successor.id));
      if (accountChange === "removed") {
        await getDb(ctx.db)
          .update(vendorAccount)
          .set({ deletedAt: new Date() })
          .where(eq(vendorAccount.id, account.id));
      } else {
        await startOrResumeRun(ctx.db, {
          ledgerPartyId: f.party.id,
          vendorAccountId: account.id,
          trigger: "manual",
        });
      }
      const dispatched = f.events.length;
      expect(
        await startRetiredObjectiveResearch(ctx.db, input, f.queue),
      ).toMatchObject({
        id: successor.id,
        status: "failed",
        failureCode: "user_cancelled",
      });
      expect(f.events).toHaveLength(dispatched);
      expect(
        await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.predecessorRunId, original.id)),
      ).toHaveLength(1);
    },
  );
  it("does not reclaim a retired receipt whose charge was allocated after retirement", async () => {
    const { f, hunt, charge, originalId, receipt } =
      await retiredReceiptFixture();
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: charge.id,
      purchaseId: f.order.id,
      amount: charge.amount,
    });
    const [before] = await getDb(ctx.db)
      .select()
      .from(importHunt)
      .where(eq(importHunt.id, hunt.id));
    expect(
      await startRetiredObjectiveResearch(
        ctx.db,
        {
          predecessorRunId: originalId,
          receiptId: receipt.receiptId,
          ledgerPartyId: f.party.id,
          actorUserId: ctx.actor.userId,
        },
        f.queue,
      ),
    ).toBeNull();
    expect(
      await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, hunt.id)),
    ).toEqual([before]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, originalId)),
    ).toEqual([]);
  });
  it.each(["before_cleanup", "while_cleanup_waits"] as const)(
    "reuses replacement receipt admission %s without changing its original",
    async (timing) => {
      const { f, hunt, originalId, receipt } = await retiredReceiptFixture();
      const replacement = await insertWithShortcode(ctx.db, "image", {
        key: `images/${crypto.randomUUID()}.jpg`,
        filename: "synthetic-replacement-receipt.jpg",
        contentType: "image/jpeg",
        size: 2048,
        status: "UPLOADED",
        sha256: "b".repeat(64),
      });
      await getDb(ctx.db)
        .update(importHunt)
        .set({ state: "receipt_failed" })
        .where(eq(importHunt.id, hunt.id));
      const input = {
        predecessorRunId: originalId,
        receiptId: receipt.receiptId,
        ledgerPartyId: f.party.id,
        actorUserId: ctx.actor.userId,
      };
      const waitForHuntAdmission = async () => {
        await vi.waitFor(
          async () => {
            const result = await getDb(ctx.db).execute(sql`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock'
              AND query LIKE '%"ImportHunt"%' AND pid <> pg_backend_pid()
          ) AS waiting`);
            expect(
              z.object({ waiting: z.boolean() }).parse(result.rows[0]).waiting,
            ).toBe(true);
          },
          { interval: 20, timeout: 5_000 },
        );
      };
      let admission:
        | ReturnType<typeof startRetiredObjectiveResearch>
        | undefined;
      if (timing === "before_cleanup") {
        await submitReceiptEvidence(
          ctx.db,
          { huntId: hunt.id, imageId: replacement.shortcode },
          ctx.actor,
          f.queue,
        );
        admission = startRetiredObjectiveResearch(ctx.db, input, f.queue);
      } else {
        await withTransaction(ctx.db, async (tx) => {
          await tx.execute(
            sql`SELECT "id" FROM "ImportHunt" WHERE "id" = ${hunt.id} FOR UPDATE`,
          );
          admission = startRetiredObjectiveResearch(ctx.db, input, f.queue);
          await waitForHuntAdmission();
          await submitReceiptEvidence(
            databaseForTransaction(tx),
            { huntId: hunt.id, imageId: replacement.shortcode },
            ctx.actor,
            f.queue,
          );
        });
      }
      const [claimed] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, hunt.id));
      const successor = await admission;
      expect(successor).toMatchObject({ id: claimed!.receiptRunId });
      expect(claimed).toMatchObject({
        receiptImageId: replacement.id,
        state: "processing_receipt",
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.predecessorRunId, originalId)),
      ).toHaveLength(1);
    },
  );
  it("refuses a retired objective with an incomplete original task roster", async () => {
    const { f, original, receipt } = await retiredAccountFixture();
    await getDb(ctx.db)
      .delete(runTarget)
      .where(eq(runTarget.runId, original.id));
    await expect(
      startRetiredObjectiveResearch(
        ctx.db,
        {
          predecessorRunId: original.id,
          receiptId: receipt.receiptId,
          ledgerPartyId: f.party.id,
          actorUserId: ctx.actor.userId,
        },
        f.queue,
      ),
    ).rejects.toThrow(/admission is incomplete/);
    const env = fromPartial<Env>({
      PURCHASE_AGENT_QUEUE: {
        send: async (event: PurchaseAgentEvent) => {
          f.events.push(purchaseAgentEvent.parse(event));
        },
      },
    });
    await expect(
      processBoundResearchRetention(ctx.db, env, {
        runId: f.mailRun.runId,
        receiptId: receipt.receiptId,
      }),
    ).rejects.toThrow(/admission is incomplete/);
    expect(
      await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, original.id)),
    ).toEqual([]);
  });
  it.each(["primary_first", "remaining_first"] as const)(
    "carries the exact unfinished account objective through overlapping bound cleanup without refreshing its cursor (%s)",
    async (ordering) => {
      const f = await fixture();
      if (!f.order.vendorId)
        throw new Error("Synthetic history Vendor missing.");
      const account = await insertWithShortcode(ctx.db, "vendorAccount", {
        vendorId: f.order.vendorId,
        ledgerPartyId: f.party.id,
        label: "Synthetic retired history account",
        browserSyncEnabled: true,
      });
      const original = await startOrResumeRun(ctx.db, {
        ledgerPartyId: f.party.id,
        vendorAccountId: account.id,
        trigger: "backfill",
        backfill: { from: "2026-08-01", to: "2026-09-30" },
      });
      const [scope] = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.id, original.id));
      if (!scope) throw new Error("Synthetic history scope missing.");
      await getDb(ctx.db)
        .update(run)
        .set({ parentRunId: f.parent.id })
        .where(eq(run.id, original.id));
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, original.id));
      if (!target) throw new Error("Synthetic history task missing.");
      await exposeResearchSources(ctx.db, {
        runId: original.id,
        sources: [f.primary, f.remaining].map((source) => ({
          orderMailId: source.id,
          checksum: source.rawChecksum,
        })),
      });
      const receipts = [await f.retire(), await f.retire(f.remaining)];
      if (ordering === "remaining_first") receipts.reverse();
      await getDb(ctx.db)
        .update(vendorAccount)
        .set({ cursor: { newestOrderAt: "2026-10-02T00:00:00Z" } })
        .where(eq(vendorAccount.id, account.id));
      const env = fromPartial<Env>({
        PURCHASE_AGENT_QUEUE: {
          send: async (event: PurchaseAgentEvent) => {
            f.events.push(purchaseAgentEvent.parse(event));
          },
        },
      });
      for (const receipt of receipts) {
        expect(
          await processBoundResearchRetention(ctx.db, env, {
            runId: f.mailRun.runId,
            receiptId: receipt.receiptId,
          }),
        ).toEqual({ completed: true });
      }
      expect(
        await getDb(ctx.db)
          .select()
          .from(run)
          .where(eq(run.predecessorRunId, runEntityId.parse(f.mailRun.runId))),
      ).toEqual([]);
      const successors = await getDb(ctx.db)
        .select()
        .from(run)
        .where(eq(run.predecessorRunId, original.id));
      expect(successors).toHaveLength(1);
      const successor = successors[0]!;
      expect(successor).toMatchObject({
        input: scope.input,
        vendorAccountId: account.id,
        parentRunId: f.parent.id,
        cause: "retry",
        attempt: 2,
        status: "running",
      });
      const tasks = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, successor.id));
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        workKey: target.workKey,
        entityKind: "run",
        entityId: successor.id,
        targetFingerprint: target.targetFingerprint,
        state: "pending",
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(runEvidence)
          .where(eq(runEvidence.runId, successor.id)),
      ).toEqual([]);
      expect(
        f.events.filter((event) => event.runId === successor.id),
      ).toHaveLength(1);
      const delivered = f.events.length;
      for (const receipt of receipts) {
        await processBoundResearchRetention(ctx.db, env, {
          runId: f.mailRun.runId,
          receiptId: receipt.receiptId,
        });
      }
      expect(f.events).toHaveLength(delivered);
      const savedReceipts = await getDb(ctx.db)
        .select()
        .from(researchRetention);
      expect(savedReceipts).toHaveLength(2);
      for (const receipt of savedReceipts) {
        expect(receipt.phase).toBe("completed");
        expect(
          receipt.plan.successors.find((entry) => entry.runId === original.id),
        ).toEqual({ runId: original.id, successorRunIds: [successor.id] });
      }
    },
  );
});
