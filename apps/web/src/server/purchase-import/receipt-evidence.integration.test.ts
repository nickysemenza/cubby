import { importRunId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { image, importHunt, importRun } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { submitReceiptEvidence } from "./receipt-evidence";

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

    // One evidence attachment, one match: exactly one ImportRun claims this
    // hunt's receipt evidence, even though submission ran twice.
    const runsForHunt = await getDb(ctx.db)
      .select({ id: importRun.id })
      .from(importRun)
      .where(eq(importRun.id, importRunId.parse(huntRow!.receiptRunId!)));
    expect(runsForHunt).toHaveLength(1);

    const allRunsForParty = await getDb(ctx.db)
      .select({ id: importRun.id })
      .from(importRun)
      .where(eq(importRun.trigger, "discovery"));
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
});
