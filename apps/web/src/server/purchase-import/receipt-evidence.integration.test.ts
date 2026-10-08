import { runEntityId } from "@cubby/schemas/identifiers";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { researchObjectivesRunInput } from "@cubby/schemas/run-fields";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  image,
  importHunt,
  run as runTable,
  runTarget,
  financialAccount,
  financialTransaction,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { listReceiptHunts, submitReceiptEvidence } from "./receipt-evidence";
import { researchServiceFor } from "./research-service";
import { controlRun } from "./run-service";

// A replacement receipt carries known lineage forward without inventing a
// historical attempt number. Existing receipt bytes and old Run stay intact.

describe("receipt hunt evidence submission is idempotent", () => {
  const ctx = withTestDb();

  const seedHunt = async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Receipt hunt member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Receipt hunt vendor ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Receipt hunt account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const financialAccount = await insertWithShortcode(
      ctx.db,
      "financialAccount",
      {
        name: "Receipt hunt card",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        ledgerPartyId: party.id,
      },
    );
    const charge = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: financialAccount.id,
      kind: "purchase",
      status: "posted",
      amount: 12.34,
      transactionDate: null,
      postedDate: "2026-09-21",
    });
    const [hunt] = await getDb(ctx.db)
      .insert(importHunt)
      .values({
        ledgerPartyId: party.id,
        financialTransactionId: charge.id,
        vendorId: vendor.id,
        vendorAccountId: account.id,
        state: "receipt_required",
        dateFrom: "2026-09-14",
        dateTo: "2026-09-28",
      })
      .returning({ id: importHunt.id });
    if (!hunt) throw new Error("Receipt hunt fixture was not created");
    const photo = await insertWithShortcode(ctx.db, "image", {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "receipt.jpg",
      contentType: "image/jpeg",
      size: 1024,
      status: "UPLOADED",
      sha256: "a".repeat(64),
    });
    return { huntId: hunt.id, imageId: photo.shortcode };
  };

  it("reuses the same import run and files no second receipt claim on a duplicate submission", async () => {
    const { huntId, imageId } = await seedHunt();
    const sent: string[] = [];
    const queue = {
      send: async (event: { type: string }) => {
        sent.push(event.type);
      },
    };

    const first = await submitReceiptEvidence(
      ctx.db,
      { huntId, imageId },
      ctx.actor,
      queue,
    );
    const second = await submitReceiptEvidence(
      ctx.db,
      { huntId, imageId },
      ctx.actor,
      queue,
    );

    expect(first).toEqual({ huntId, imageId, queued: true });
    // Resubmitting the exact same evidence for the exact same hunt is a
    // retry of the same claim, not a second one.
    expect(second).toEqual({ huntId, imageId, queued: true });

    const [huntRow] = await getDb(ctx.db)
      .select({
        receiptImageId: importHunt.receiptImageId,
        receiptRunId: importHunt.receiptRunId,
        state: importHunt.state,
      })
      .from(importHunt)
      .where(eq(importHunt.id, huntId));
    expect(huntRow?.state).toBe("processing_receipt");

    const [imageRow] = await getDb(ctx.db)
      .select({ id: image.id })
      .from(image)
      .where(eq(image.shortcode, imageId));
    expect(huntRow?.receiptImageId).toBe(imageRow?.id);

    // One evidence attachment, one match: exactly one Run claims this
    // hunt's receipt evidence, even though submission ran twice.
    const runsForHunt = await getDb(ctx.db)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.id, runEntityId.parse(huntRow!.receiptRunId!)));
    expect(runsForHunt).toHaveLength(1);

    const allRunsForParty = await getDb(ctx.db)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.trigger, "discovery"));
    expect(allRunsForParty).toHaveLength(1);

    // The first submission starts the coordinator; the retry resumes the
    // same run rather than starting a second one.
    expect(sent).toEqual(["start_or_resume", "retry"]);
  });

  it("rejects a different image for a hunt whose evidence is already processing", async () => {
    const { huntId, imageId } = await seedHunt();
    const otherImage = await insertWithShortcode(ctx.db, "image", {
      key: `images/${crypto.randomUUID()}.jpg`,
      filename: "other-receipt.jpg",
      contentType: "image/jpeg",
      size: 2048,
      status: "UPLOADED",
      sha256: "b".repeat(64),
    });
    const queue = { send: async () => undefined };

    await submitReceiptEvidence(ctx.db, { huntId, imageId }, ctx.actor, queue);

    await expect(
      submitReceiptEvidence(
        ctx.db,
        { huntId, imageId: otherImage.shortcode },
        ctx.actor,
        queue,
      ),
    ).rejects.toThrow("already has different evidence");

    const [huntRow] = await getDb(ctx.db)
      .select({ receiptImageId: importHunt.receiptImageId })
      .from(importHunt)
      .where(eq(importHunt.id, huntId));
    const [imageRow] = await getDb(ctx.db)
      .select({ id: image.id })
      .from(image)
      .where(eq(image.shortcode, imageId));
    expect(huntRow?.receiptImageId).toBe(imageRow?.id);
  });
  it.each([null, 3])(
    "preserves an unknown or known predecessor attempt when replacing failed receipt evidence: %s",
    async (attempt) => {
      const { huntId, imageId } = await seedHunt();
      const events: unknown[] = [];
      const queue = {
        send: async (event: unknown) => {
          events.push(purchaseAgentEvent.parse(event));
        },
      };
      await submitReceiptEvidence(
        ctx.db,
        { huntId, imageId },
        ctx.actor,
        queue,
      );
      const [priorHunt] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, huntId));
      if (!priorHunt?.receiptRunId)
        throw new Error("Synthetic receipt predecessor missing");
      const priorRunId = runEntityId.parse(priorHunt.receiptRunId);
      const [initial] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, priorRunId));
      if (!initial) throw new Error("Synthetic receipt admission missing");
      const parent = await insertWithShortcode(ctx.db, "run", {
        purpose: "background",
        trigger: "manual",
        status: "completed",
        ledgerPartyId: initial.ledgerPartyId,
        actorUserId: initial.actorUserId,
        actorName: initial.actorName,
        actorEmail: initial.actorEmail,
        actorLedgerPartyShortcode: initial.actorLedgerPartyShortcode,
        actorLedgerPartyName: initial.actorLedgerPartyName,
        actorLedgerPartyKind: initial.actorLedgerPartyKind,
      });
      await getDb(ctx.db)
        .update(runTable)
        .set({ attempt, parentRunId: parent.id, status: "needs_review" })
        .where(eq(runTable.id, priorRunId));
      await getDb(ctx.db)
        .update(importHunt)
        .set({ state: "receipt_failed" })
        .where(eq(importHunt.id, huntId));
      const [predecessor] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, priorRunId));
      const oldImages = await getDb(ctx.db).select().from(image);
      const replacement = await insertWithShortcode(ctx.db, "image", {
        key: `images/${crypto.randomUUID()}.jpg`,
        filename: "replacement-receipt.jpg",
        contentType: "image/jpeg",
        size: 2048,
        status: "UPLOADED",
        sha256: "b".repeat(64),
      });
      await submitReceiptEvidence(
        ctx.db,
        { huntId, imageId: replacement.shortcode },
        ctx.actor,
        queue,
      );
      const [nextHunt] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, huntId));
      if (!nextHunt?.receiptRunId)
        throw new Error("Synthetic receipt successor missing");
      expect(nextHunt.receiptRunId).not.toBe(priorRunId);
      const [successor] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, runEntityId.parse(nextHunt.receiptRunId)));
      expect(successor).toMatchObject({
        predecessorRunId: priorRunId,
        parentRunId: parent.id,
        attempt: attempt === null ? null : attempt + 1,
        cause: "evidence_changed",
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(runTable)
          .where(eq(runTable.id, priorRunId)),
      ).toEqual([predecessor]);
      const images = await getDb(ctx.db).select().from(image);
      expect(images.filter((row) => row.id !== replacement.id)).toEqual(
        oldImages,
      );
      expect(events).toHaveLength(2);
    },
  );
  it("converts an unresolved legacy receipt into one fresh objective from its retained image and owned charge", async () => {
    const { huntId, imageId } = await seedHunt();
    const events: unknown[] = [];
    const queue = {
      send: async (event: unknown) => {
        events.push(purchaseAgentEvent.parse(event));
      },
    };
    await submitReceiptEvidence(ctx.db, { huntId, imageId }, ctx.actor, queue);
    const [hunt] = await getDb(ctx.db)
      .select()
      .from(importHunt)
      .where(eq(importHunt.id, huntId));
    if (!hunt?.receiptRunId || !hunt.receiptImageId)
      throw new Error("Synthetic receipt history missing");
    const predecessorId = runEntityId.parse(hunt.receiptRunId);
    await getDb(ctx.db)
      .update(runTable)
      .set({ input: null, attempt: null, status: "needs_review" })
      .where(eq(runTable.id, predecessorId));
    await getDb(ctx.db)
      .update(importHunt)
      .set({ state: "receipt_failed" })
      .where(eq(importHunt.id, huntId));
    const [predecessor] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, predecessorId));
    const priorTargets = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.runId, predecessorId));
    const images = await getDb(ctx.db).select().from(image);
    const charges = await getDb(ctx.db).select().from(financialTransaction);
    await submitReceiptEvidence(ctx.db, { huntId, imageId }, ctx.actor, queue);
    const [nextHunt] = await getDb(ctx.db)
      .select()
      .from(importHunt)
      .where(eq(importHunt.id, huntId));
    if (!nextHunt?.receiptRunId)
      throw new Error("Converted receipt Run missing");
    expect(nextHunt.receiptRunId).not.toBe(predecessorId);
    const nextId = runEntityId.parse(nextHunt.receiptRunId);
    const [nextRun] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, nextId));
    if (!nextRun) throw new Error("Converted receipt Run missing");
    expect(nextRun).toMatchObject({
      predecessorRunId: predecessorId,
      parentRunId: null,
      attempt: null,
      cause: "retry",
      status: "running",
    });
    expect(researchObjectivesRunInput.parse(nextRun.input)).toMatchObject({
      objectives: [
        {
          kind: "receipt_hunt",
          huntId,
          imageId: hunt.receiptImageId,
          checksum: images.find((row) => row.id === hunt.receiptImageId)
            ?.sha256,
        },
      ],
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, nextId)),
    ).toMatchObject([
      { workKey: `receipt_hunt:${huntId}`, state: "pending", entityId: nextId },
    ]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, predecessorId)),
    ).toEqual([predecessor]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, predecessorId)),
    ).toEqual(priorTargets);
    expect(await getDb(ctx.db).select().from(image)).toEqual(images);
    expect(await getDb(ctx.db).select().from(financialTransaction)).toEqual(
      charges,
    );
    await submitReceiptEvidence(ctx.db, { huntId, imageId }, ctx.actor, queue);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(importHunt)
          .where(eq(importHunt.id, huntId))
      )[0]?.receiptRunId,
    ).toBe(nextId);
    expect(events).toHaveLength(3);
  });
  it.each(["retry", "restart"] as const)(
    "converts a stopped legacy receipt through public %s without reupload or mutable history",
    async (action) => {
      const { huntId, imageId } = await seedHunt();
      await submitReceiptEvidence(ctx.db, { huntId, imageId }, ctx.actor, {
        send: async (event: unknown) => {
          purchaseAgentEvent.parse(event);
        },
      });
      const [hunt] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, huntId));
      if (!hunt?.receiptRunId || !hunt.receiptImageId)
        throw new Error("Synthetic retained receipt missing");
      const predecessorId = runEntityId.parse(hunt.receiptRunId);
      await getDb(ctx.db)
        .update(runTable)
        .set({
          input: null,
          attempt: null,
          status: "needs_review",
          endedAt: new Date(),
        })
        .where(eq(runTable.id, predecessorId));
      await getDb(ctx.db)
        .update(importHunt)
        .set({ state: "receipt_failed" })
        .where(eq(importHunt.id, huntId));
      await getDb(ctx.db)
        .update(runTarget)
        .set({
          entityKind: "image",
          entityId: hunt.receiptImageId,
          workKey: "legacy-receipt",
          state: "needs_evidence",
        })
        .where(eq(runTarget.runId, predecessorId));
      const [predecessor] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, predecessorId));
      if (!predecessor) throw new Error("Synthetic legacy Run missing");
      const targets = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.runId, predecessorId));
      const images = await getDb(ctx.db).select().from(image);
      const control = { runPublicId: predecessor.shortcode, action };
      const result = await controlRun(ctx.db, ctx.actor, control);
      if (!("successorRunId" in result) || !result.successorRunId)
        throw new Error("Synthetic successor missing");
      const successorId = runEntityId.parse(result.successorRunId);
      const [successor] = await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, successorId));
      expect(
        researchObjectivesRunInput.parse(successor?.input).objectives,
      ).toEqual([
        {
          kind: "receipt_hunt",
          huntId,
          imageId: hunt.receiptImageId,
          checksum: "a".repeat(64),
        },
      ]);
      expect(successor).toMatchObject({
        predecessorRunId: predecessorId,
        parentRunId: predecessor.parentRunId,
        attempt: null,
        cause: "retry",
      });
      expect(
        await researchServiceFor(
          ctx.db,
          fromPartial<Env>({}),
          successorId,
        ).researchNext({}, crypto.randomUUID()),
      ).toMatchObject({
        status: "working",
        work: { kind: "receipt_hunt", receipt: { imageRef: imageId } },
      });
      expect(
        await getDb(ctx.db)
          .select()
          .from(importHunt)
          .where(eq(importHunt.id, huntId)),
      ).toMatchObject([
        {
          receiptRunId: successorId,
          receiptImageId: hunt.receiptImageId,
          state: "processing_receipt",
        },
      ]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(runTable)
          .where(eq(runTable.id, predecessorId)),
      ).toEqual([predecessor]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(runTarget)
          .where(eq(runTarget.runId, predecessorId)),
      ).toEqual(targets);
      expect(await getDb(ctx.db).select().from(image)).toEqual(images);
      if (!successor) throw new Error("Synthetic successor row missing");
      await controlRun(ctx.db, ctx.actor, {
        runPublicId: successor.shortcode,
        action: "cancel",
      });
      const replay = await controlRun(ctx.db, ctx.actor, control);
      expect(replay).toMatchObject({
        successorRunId: successorId,
        successorStatus: "failed",
        created: false,
      });
      expect(replay).not.toHaveProperty("dispatchRunId");
    },
  );
  it("lists a receipt hunt without inventing its unknown transaction date", async () => {
    const { huntId } = await seedHunt();
    expect(await listReceiptHunts(ctx.db, ctx.actor)).toEqual({
      items: [
        {
          id: huntId,
          transactionDate: null,
          merchant: null,
          amountInCents: 1234,
        },
      ],
    });
  });
  it("refuses receipt admission when its hunt no longer points to this member's charge", async () => {
    const { huntId, imageId } = await seedHunt();
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ transactionDate: "2026-09-20" });
    const other = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Other synthetic charge owner",
      kind: "member",
    });
    const [account] = await getDb(ctx.db).select().from(financialAccount);
    if (!account) throw new Error("Synthetic financial account missing");
    await getDb(ctx.db)
      .update(financialAccount)
      .set({ ledgerPartyId: other.id })
      .where(eq(financialAccount.id, account.id));
    const hunts = await getDb(ctx.db).select().from(importHunt);
    const images = await getDb(ctx.db).select().from(image);
    const events: unknown[] = [];
    expect(await listReceiptHunts(ctx.db, ctx.actor)).toEqual({ items: [] });
    await expect(
      submitReceiptEvidence(ctx.db, { huntId, imageId }, ctx.actor, {
        send: async (event: unknown) => {
          events.push(purchaseAgentEvent.parse(event));
        },
      }),
    ).rejects.toThrow(/Receipt|receipt/u);
    expect(events).toEqual([]);
    expect(await getDb(ctx.db).select().from(runTable)).toEqual([]);
    expect(await getDb(ctx.db).select().from(importHunt)).toEqual(hunts);
    expect(await getDb(ctx.db).select().from(image)).toEqual(images);
  });
  it.each([
    "cancelled",
    "dispatch_aborted",
    "resolved",
    "active",
    "unfinalized",
  ] as const)(
    "preserves legacy receipt history without admitting %s work",
    async (problem) => {
      const { huntId, imageId } = await seedHunt();
      const queue = { send: async () => {} };
      await submitReceiptEvidence(
        ctx.db,
        { huntId, imageId },
        ctx.actor,
        queue,
      );
      const [hunt] = await getDb(ctx.db)
        .select()
        .from(importHunt)
        .where(eq(importHunt.id, huntId));
      if (!hunt?.receiptRunId || !hunt.receiptImageId)
        throw new Error("Synthetic receipt history missing");
      await getDb(ctx.db)
        .update(runTable)
        .set({
          input: null,
          attempt: null,
          status:
            problem === "cancelled" || problem === "dispatch_aborted"
              ? "failed"
              : problem === "active"
                ? "running"
                : "needs_review",
          failureCode:
            problem === "cancelled"
              ? "user_cancelled"
              : problem === "dispatch_aborted"
                ? "dispatch_aborted"
                : null,
        })
        .where(eq(runTable.id, runEntityId.parse(hunt.receiptRunId)));
      await getDb(ctx.db)
        .update(importHunt)
        .set({ state: problem === "resolved" ? "resolved" : "receipt_failed" })
        .where(eq(importHunt.id, huntId));
      if (problem === "unfinalized")
        await getDb(ctx.db)
          .update(image)
          .set({ sha256: null })
          .where(eq(image.id, hunt.receiptImageId));
      const before = {
        runs: await getDb(ctx.db).select().from(runTable),
        hunts: await getDb(ctx.db).select().from(importHunt),
        images: await getDb(ctx.db).select().from(image),
        targets: await getDb(ctx.db).select().from(runTarget),
      };
      const events: unknown[] = [];
      await expect(
        submitReceiptEvidence(ctx.db, { huntId, imageId }, ctx.actor, {
          send: async (event: unknown) => {
            events.push(purchaseAgentEvent.parse(event));
          },
        }),
      ).rejects.toThrow(/Receipt|receipt/u);
      expect(events).toEqual([]);
      expect(await getDb(ctx.db).select().from(runTable)).toEqual(before.runs);
      expect(await getDb(ctx.db).select().from(importHunt)).toEqual(
        before.hunts,
      );
      expect(await getDb(ctx.db).select().from(image)).toEqual(before.images);
      expect(await getDb(ctx.db).select().from(runTarget)).toEqual(
        before.targets,
      );
    },
  );
});
