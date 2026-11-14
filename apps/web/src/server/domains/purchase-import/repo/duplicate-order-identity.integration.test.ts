import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { type ExtractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { eq, isNull } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted, withTransaction } from "~/server/db/helpers";
import { expense, importSourceOrder, purchase } from "~/server/db/schema";
import { createPurchaseEventRecord } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import {
  findOrCreatePurchase,
  renameChargeOrderId,
} from "~/server/domains/purchase/repo/purchase";

import {
  mailSource,
  memberImport,
  memberImportWorld,
  prepareMemberImport,
  retainedMailFixture,
  type MemberImportOrder,
} from "../operations/order-import.fixtures";
import { convergeDuplicateSourceOrder } from "./source-order-convergence";

const checksum = (digit: string) => digit.repeat(64);

// One order arriving as two source documents (a pre-payment notice and its
// receipt) must stay one Purchase: label-variant order ids converge, a
// same-thread Purchase is the reviewed target rather than a second Purchase,
// and an existing duplicate converges atomically without double spend.
describe("one order from two source documents", () => {
  const ctx = withTestDb();

  const candidate = (orderId: string | null): ExtractedOrderCandidate => ({
    orderId,
    orderedAt: "2026-10-01T12:00:00Z",
    merchant: "Synthetic ride merchant",
    currency: "USD",
    printedGrandTotal: 12.5,
    lines: [
      {
        title: "Synthetic fare",
        amount: 10,
        quantity: 1,
        lineKind: "principal",
      },
      { title: "Synthetic fee", amount: 2.5, quantity: 1, lineKind: "fee" },
    ],
    payments: [],
    allShipmentsDelivered: true,
  });

  async function threadMails(threadA: string, threadB: string) {
    const world = await memberImportWorld(ctx.db, ctx.actor);
    const notice = await retainedMailFixture(ctx.db, {
      ledgerPartyId: world.party.id,
      messageId: "synthetic-notice",
      threadId: threadA,
      checksum: checksum("a"),
      receivedAt: new Date("2026-10-01T13:00:00Z"),
    });
    const receipt = await retainedMailFixture(ctx.db, {
      ledgerPartyId: world.party.id,
      messageId: "synthetic-receipt",
      threadId: threadB,
      checksum: checksum("b"),
      receivedAt: new Date("2026-10-01T15:00:00Z"),
    });
    return { ...world, notice, receipt };
  }

  const liveCents = async () =>
    (
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .where(notDeleted(expense))
    ).reduce((total, row) => total + Number(row.cost ?? 0n), 0);
  const livePurchases = () =>
    getDb(ctx.db)
      .select({ shortcode: purchase.shortcode, orderId: purchase.orderId })
      .from(purchase)
      .where(isNull(purchase.deletedAt));

  it("stores the canonical order id and converges a label-variant id on it", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const first = await memberImport(ctx.db, ctx.actor, {
      key: "labelled",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "labelled",
          vendorId: vendor.shortcode,
          source: {
            kind: "receipt_photo",
            externalKey: "synthetic:labelled",
            checksum: checksum("c"),
          },
          extraction: {
            status: "ready",
            candidate: candidate("Trip ID: abc-123"),
          },
        },
      ],
    });
    const second = await memberImport(ctx.db, ctx.actor, {
      key: "bare",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "bare",
          vendorId: vendor.shortcode,
          source: {
            kind: "receipt_photo",
            externalKey: "synthetic:bare",
            checksum: checksum("d"),
          },
          extraction: { status: "ready", candidate: candidate("ABC-123") },
        },
      ],
    });
    expect(second.committed.items[0]?.purchaseId).toBe(
      first.committed.items[0]?.purchaseId,
    );
    expect(await livePurchases()).toEqual([
      { shortcode: first.committed.items[0]?.purchaseId, orderId: "abc-123" },
    ]);
    expect(await liveCents()).toBe(1250);
  });

  it("refuses a second Purchase beside a same-thread Purchase and imports into the reviewed target", async () => {
    const { vendor, notice, receipt } = await threadMails(
      "thread-1",
      "thread-1",
    );
    const noticeImport = await memberImport(ctx.db, ctx.actor, {
      key: "notice",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "notice",
          vendorId: vendor.shortcode,
          source: mailSource(notice),
          extraction: { status: "ready", candidate: candidate(null) },
        },
      ],
    });
    const target = noticeImport.committed.items[0]?.purchaseId;
    if (!target) throw new Error("The notice created no Purchase");
    const receiptOrder = {
      stableOrderId: "receipt",
      vendorId: vendor.shortcode,
      source: mailSource(receipt),
      extraction: {
        status: "ready" as const,
        candidate: candidate("Trip ID: XYZ-9"),
      },
    };
    await expect(
      prepareMemberImport(ctx.db, ctx.actor, {
        key: "receipt-untargeted",
        orders: [receiptOrder],
      }),
    ).rejects.toThrow(/same Email thread.*may already hold this order/);

    const targeted = await memberImport(ctx.db, ctx.actor, {
      key: "receipt-targeted",
      defaultTrade: "other",
      orders: [{ ...receiptOrder, targetPurchaseId: target }],
    });
    expect(targeted.committed.items[0]?.purchaseId).toBe(target);
    expect(await livePurchases()).toEqual([
      { shortcode: target, orderId: "XYZ-9" },
    ]);
    expect(await liveCents()).toBe(1250);
  });

  it("converges an existing duplicate atomically and replays its source inertly", async () => {
    const { vendor, notice, receipt } = await threadMails(
      "thread-a",
      "thread-a",
    );
    const importOne = (
      key: string,
      mail: typeof notice,
      orderId: string | null,
      distinctFromPurchases?: MemberImportOrder["distinctFromPurchases"],
    ) =>
      memberImport(ctx.db, ctx.actor, {
        key,
        defaultTrade: "other",
        orders: [
          {
            stableOrderId: key,
            vendorId: vendor.shortcode,
            source: mailSource(mail),
            distinctFromPurchases,
            extraction: { status: "ready", candidate: candidate(orderId) },
          },
        ],
      });
    const duplicate = (await importOne("notice", notice, null)).committed
      .items[0]?.purchaseId;
    if (!duplicate) throw new Error("The notice must commit");
    // The pre-fix duplicate: the receipt imported beside the notice.
    const survivor = (
      await importOne("receipt", receipt, "Trip ID: R-1", [duplicate])
    ).committed.items[0]?.purchaseId;
    if (!survivor) throw new Error("The receipt must commit");
    expect(duplicate).not.toBe(survivor);
    expect(await liveCents()).toBe(2500);

    const converged = await convergeDuplicateSourceOrder(
      ctx.db,
      { survivorPurchaseId: survivor, duplicatePurchaseId: duplicate },
      ctx.actor,
    );
    expect(converged).toMatchObject({
      status: "applied",
      survivorPurchaseId: survivor,
      movedSourceOrders: 1,
    });
    expect(converged.retiredExpenseIds).toHaveLength(2);
    expect(await livePurchases()).toEqual([
      { shortcode: survivor, orderId: "R-1" },
    ]);
    expect(await liveCents()).toBe(1250);
    const [kept] = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.shortcode, survivor));
    expect(
      await getDb(ctx.db)
        .select({ purchaseId: importSourceOrder.purchaseId })
        .from(importSourceOrder),
    ).toEqual([{ purchaseId: kept?.id }, { purchaseId: kept?.id }]);

    const replay = await importOne("notice-replay", notice, null);
    expect(replay.committed.items[0]?.purchaseId).toBe(survivor);
    expect(await liveCents()).toBe(1250);
    expect(await livePurchases()).toHaveLength(1);
    await expect(
      convergeDuplicateSourceOrder(
        ctx.db,
        { survivorPurchaseId: survivor, duplicatePurchaseId: duplicate },
        ctx.actor,
      ),
    ).resolves.toMatchObject({ status: "already_applied" });
  });

  it("refuses to converge two rides from different threads when one carries no order id", async () => {
    const { vendor, notice, receipt } = await threadMails("ride-1", "ride-2");
    const ids = [];
    for (const [key, mail, orderId = null] of [
      ["ride-1", notice, null],
      ["ride-2", receipt, "R-2"],
    ] as const)
      ids.push(
        (
          await memberImport(ctx.db, ctx.actor, {
            key,
            defaultTrade: "other",
            orders: [
              {
                stableOrderId: key,
                vendorId: vendor.shortcode,
                source: mailSource(mail),
                extraction: { status: "ready", candidate: candidate(orderId) },
              },
            ],
          })
        ).committed.items[0]?.purchaseId,
      );
    const [first, second] = ids;
    if (!first || !second) throw new Error("Both rides must commit");
    await expect(
      convergeDuplicateSourceOrder(
        ctx.db,
        { survivorPurchaseId: first, duplicatePurchaseId: second },
        ctx.actor,
      ),
    ).rejects.toThrow(/may be two orders/);
    expect(await liveCents()).toBe(2500);
  });

  it("refuses case and whitespace variants of one Vendor order id that several Purchases carry", async () => {
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor);
    const stored = {
      case: ["AMB-1", "amb-1"],
      whitespace: ["WS-2", "WS-2 "],
    } as const;
    const owners: Record<string, string[]> = {};
    for (const [variant, orderIds] of Object.entries(stored))
      for (const orderId of orderIds)
        (owners[variant] ??= []).push(
          (
            await createPurchaseEventRecord(ctx.db, "purchase", {
              vendorId: vendor.id,
              orderId,
            })
          ).shortcode,
        );
    const order = (key: string, orderId: string, target?: string) => ({
      stableOrderId: key,
      vendorId: vendor.shortcode,
      ...(target
        ? { targetPurchaseId: parseShortcodeFor("purchase", target) }
        : {}),
      source: {
        kind: "receipt_photo" as const,
        externalKey: `synthetic:${key}`,
        checksum: checksum("e"),
      },
      extraction: { status: "ready" as const, candidate: candidate(orderId) },
    });
    for (const [key, orderId] of [
      ["case-variant", "AMB-1"],
      ["whitespace-variant", "WS-2"],
    ] as const)
      await expect(
        prepareMemberImport(ctx.db, ctx.actor, {
          key,
          orders: [order(key, orderId)],
        }),
      ).rejects.toThrow(/Several Purchases of this Vendor carry this order id/);
    // A reviewed target settles the ambiguity while the other owner has no lines.
    const reviewed = await memberImport(ctx.db, ctx.actor, {
      key: "reviewed-variant",
      defaultTrade: "other",
      orders: [order("reviewed-variant", "amb-1", owners.case?.[0])],
    });
    expect(reviewed.committed.items[0]?.purchaseId).toBe(owners.case?.[0]);

    await expect(
      findOrCreatePurchase(ctx.db, {
        vendorId: vendor.id,
        orderId: "ws-2",
        date: "2026-10-01",
      }),
    ).rejects.toThrow(/Several purchases for this vendor carry order id/);
    const single = await createPurchaseEventRecord(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "one-1",
    });
    expect(
      await findOrCreatePurchase(ctx.db, {
        vendorId: vendor.id,
        orderId: " ONE-1",
        date: "2026-10-01",
      }),
    ).toBe(single.id);
    const other = await createPurchaseEventRecord(ctx.db, "purchase", {
      vendorId: vendor.id,
      orderId: "two-2",
    });
    expect(
      await withTransaction(ctx.db, (tx) =>
        renameChargeOrderId(tx, other.id, "ONE-1", ctx.actor),
      ),
    ).toBe(false);
    expect(
      await withTransaction(ctx.db, (tx) =>
        renameChargeOrderId(tx, other.id, "TWO-2", ctx.actor),
      ),
    ).toBe(true);
  });
});
