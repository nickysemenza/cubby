import { purchaseId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
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
  orderMailEvent,
  purchase as purchaseTable,
  vendorAccount,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
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
    for (let offset = 0; offset < 501; offset += 100) {
      await getDb(ctx.db)
        .insert(purchaseTable)
        .values(
          Array.from({ length: Math.min(100, 501 - offset) }, (_, index) => ({
            id: purchaseId.parse(crypto.randomUUID()),
            shortcode: generateShortcode("purchase"),
            vendorId: vendor.id,
            orderId: `TS-NEWER-${offset + index}`,
            date: "2026-09-10",
          })),
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
