import { purchaseId } from "@cubby/schemas/identifiers";
import { purchaseShortcode, SHORTCODE_CHARS } from "@cubby/shared";
import { eq } from "drizzle-orm";
/**
 * Mail matching failure modes: an exact order can be dismissed, the dismissal
 * survives rereads, and a later explicit link replaces it without creating a
 * Purchase or changing spend.
 */
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  orderMail,
  orderMailCandidateDecision,
  orderMailEvent,
  purchase as purchaseTable,
  vendorAccount,
} from "~/server/db/schema";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { mergePurchases } from "~/server/repo/purchase";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import {
  decideOrderMailCandidate,
  listPurchaseOrderMail,
  listVendorOrderMail,
} from "./review";

describe("Vendor order mail review", () => {
  const ctx = withTestDb();

  it("keeps exact matches reviewable and honors a durable dismiss or link", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Trail Shop",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "TS-SYN-1001",
      date: "2026-09-10",
      statedTotal: 48,
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        messageId: "review-mail-1",
        threadId: "review-thread-1",
        sender: "Example Trail Shop <orders@example.test>",
        subject: "Order update",
        receivedAt: new Date("2026-09-10T15:00:00.000Z"),
        rawChecksum: "review-checksum-1",
      })
      .returning({ id: orderMail.id });
    if (!mail) throw new Error("test setup: mail missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: "TS-SYN-1001",
        amount: 48,
        currency: "USD",
        sourceKey: "classified:review-checksum-1:0",
      })
      .returning({ id: orderMailEvent.id });
    if (!event) throw new Error("test setup: event missing");

    const input = {
      vendorId: vendor.shortcode,
      ledgerPartyId: party.shortcode,
    };
    expect(
      (
        await listVendorOrderMail(ctx.db, input, {
          messageIds: ["review-mail-1"],
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (await listVendorOrderMail(ctx.db, input)).items[0]?.events[0]
        ?.candidates[0],
    ).toMatchObject({
      purchaseId: purchase.shortcode,
      reason: "exact_order_id",
      decision: null,
    });

    await decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event.id,
        purchaseId: purchase.shortcode,
        decision: "dismissed",
        evidenceChecksum: "review-checksum-1",
      },
      ctx.actor,
    );
    expect(
      (await listVendorOrderMail(ctx.db, input)).items[0]?.events[0]
        ?.candidates[0]?.decision,
    ).toBe("dismissed");

    await decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event.id,
        purchaseId: purchase.shortcode,
        decision: "linked",
        evidenceChecksum: "review-checksum-1",
      },
      ctx.actor,
    );
    expect(
      (await listVendorOrderMail(ctx.db, input)).items[0]?.events[0]
        ?.candidates[0]?.decision,
    ).toBe("linked");
    const [account] = await getDb(ctx.db)
      .select({
        id: vendorAccount.id,
        browserSyncEnabled: vendorAccount.browserSyncEnabled,
      })
      .from(vendorAccount)
      .where(eq(vendorAccount.vendorId, vendor.id));
    const [linkedPurchase] = await getDb(ctx.db)
      .select({ vendorAccountId: purchaseTable.vendorAccountId })
      .from(purchaseTable)
      .where(eq(purchaseTable.id, purchase.id));
    expect(account?.browserSyncEnabled).toBe(false);
    expect(linkedPurchase?.vendorAccountId).toBeNull();
  });

  it("offers Purchases within 45 household days of the mail as nearby candidates", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic window reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Window Shop",
    });
    // 02:00Z on 09-18 is the evening of 09-17 in the household; 08-03 is
    // exactly 45 household days earlier, 08-02 one day too many.
    const edge = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-03",
    });
    await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-02",
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        messageId: "review-window-mail",
        sender: "Example Window Shop <orders@example.test>",
        subject: "Order update",
        receivedAt: new Date("2026-09-18T02:00:00.000Z"),
        rawChecksum: "review-window-checksum",
      })
      .returning({ id: orderMail.id });
    if (!mail) throw new Error("test setup: mail missing");
    await getDb(ctx.db).insert(orderMailEvent).values({
      orderMailId: mail.id,
      event: "placed",
      orderId: "WS-SYN-2001",
      amount: 12,
      currency: "USD",
      sourceKey: "classified:review-window-checksum:0",
    });

    const candidates = (
      await listVendorOrderMail(ctx.db, {
        vendorId: vendor.shortcode,
        ledgerPartyId: party.shortcode,
      })
    ).items[0]?.events[0]?.candidates;
    expect(candidates?.map((candidate) => candidate.purchaseId)).toEqual([
      edge.shortcode,
    ]);
    expect(candidates?.[0]?.reason).toBe("nearby_date");
  });

  it("lets a member's link win over an automatic link committed mid-decision", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic race reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Race Shop",
    });
    const [automatic, chosen] = await Promise.all(
      ["RACE-1", "RACE-2"].map((orderId) =>
        insertWithShortcode(ctx.db, "purchase", {
          vendorId: vendor.id,
          orderId,
          date: "2026-09-10",
        }),
      ),
    );
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        messageId: "race-mail-1",
        sender: "orders@race.example.test",
        subject: "Order update",
        receivedAt: new Date("2026-09-10T15:00:00.000Z"),
        rawChecksum: "race-checksum-1",
      })
      .returning({ id: orderMail.id });
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail!.id,
        event: "placed",
        orderId: "RACE-1",
        currency: "USD",
        sourceKey: "classified:race-checksum-1:0",
      })
      .returning({ id: orderMailEvent.id });

    // An automatic link sits uncommitted while the member links elsewhere.
    let commitAutomatic = () => {};
    const held = new Promise<void>((resolve) => {
      commitAutomatic = resolve;
    });
    const automaticLink = withTransaction(ctx.db, async (tx) => {
      await tx.insert(orderMailCandidateDecision).values({
        eventId: event!.id,
        purchaseId: automatic!.id,
        decision: "linked",
        evidenceChecksum: "race-checksum-1",
        decidedByUserId: "cubby-system",
      });
      await held;
    });
    const memberLink = decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event!.id,
        purchaseId: chosen!.shortcode,
        decision: "linked",
        evidenceChecksum: "race-checksum-1",
      },
      ctx.actor,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    commitAutomatic();
    await automaticLink;
    await expect(memberLink).resolves.toMatchObject({ decision: "linked" });

    const links = await getDb(ctx.db)
      .select({ purchaseId: orderMailCandidateDecision.purchaseId })
      .from(orderMailCandidateDecision)
      .where(eq(orderMailCandidateDecision.decision, "linked"));
    expect(links).toEqual([{ purchaseId: chosen!.id }]);
  });

  it("retains an older exact order candidate beyond the newest 500 Purchases", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Trail Shop",
    });
    const older = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "TS-OLDER-1001",
      date: "2024-01-01",
    });
    const shortcodes = Array.from({ length: 502 }, (_, index) => {
      let value = index;
      let body = "";
      for (let digit = 0; digit < 4; digit++) {
        body = SHORTCODE_CHARS.charAt(value % SHORTCODE_CHARS.length) + body;
        value = Math.floor(value / SHORTCODE_CHARS.length);
      }
      return purchaseShortcode.parse(`PUR-${body}`);
    }).filter((shortcode) => shortcode !== older.shortcode);
    for (let offset = 0; offset < 501; offset += 100) {
      await getDb(ctx.db)
        .insert(purchaseTable)
        .values(
          Array.from({ length: Math.min(100, 501 - offset) }, (_, index) => {
            const shortcode = shortcodes[offset + index];
            if (!shortcode) throw new Error("test setup: shortcode missing");
            return {
              id: purchaseId.parse(crypto.randomUUID()),
              shortcode,
              vendorId: vendor.id,
              orderId: `TS-NEWER-${offset + index}`,
              date: "2026-09-10",
            };
          }),
        );
    }
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        messageId: "older-order-mail",
        sender: "orders@example.test",
        subject: "Older order update",
        receivedAt: new Date("2026-09-10T15:00:00.000Z"),
        rawChecksum: "older-order-checksum",
      })
      .returning({ id: orderMail.id });
    if (!mail) throw new Error("test setup: mail missing");
    await getDb(ctx.db).insert(orderMailEvent).values({
      orderMailId: mail.id,
      event: "delivered",
      orderId: "TS-OLDER-1001",
      sourceKey: "classified:older-order-checksum:0",
    });
    const worklist = await listVendorOrderMail(ctx.db, {
      vendorId: vendor.shortcode,
    });
    expect(worklist.items[0]?.events[0]?.candidates[0]).toMatchObject({
      purchaseId: older.shortcode,
      reason: "exact_order_id",
    });
  });

  it("carries a reviewed mail link to the surviving Purchase on merge", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic mail reviewer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example Trail Shop",
    });
    const loser = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "TS-MERGE-1001",
      date: "2026-09-10",
    });
    const keeper = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-09-10",
    });
    const [mail] = await getDb(ctx.db)
      .insert(orderMail)
      .values({
        ledgerPartyId: party.id,
        vendorId: vendor.id,
        messageId: "merged-order-mail",
        sender: "orders@example.test",
        subject: "Merged order update",
        receivedAt: new Date("2026-09-10T15:00:00.000Z"),
        rawChecksum: "merged-mail-checksum",
      })
      .returning({ id: orderMail.id });
    if (!mail) throw new Error("test setup: mail missing");
    const [event] = await getDb(ctx.db)
      .insert(orderMailEvent)
      .values({
        orderMailId: mail.id,
        event: "placed",
        orderId: "TS-MERGE-1001",
        sourceKey: "classified:merged-mail-checksum:0",
      })
      .returning({ id: orderMailEvent.id });
    if (!event) throw new Error("test setup: event missing");
    await decideOrderMailCandidate(
      ctx.db,
      {
        eventId: event.id,
        purchaseId: loser.shortcode,
        decision: "linked",
        evidenceChecksum: "merged-mail-checksum",
      },
      ctx.actor,
    );
    await mergePurchases(
      ctx.db,
      { keepId: keeper.shortcode, mergeIds: [loser.shortcode] },
      ctx.actor,
    );
    const timeline = await listPurchaseOrderMail(ctx.db, {
      purchaseId: keeper.shortcode,
    });
    expect(timeline.items[0]?.events[0]?.candidates[0]).toMatchObject({
      purchaseId: keeper.shortcode,
      decision: "linked",
    });
  });
});
