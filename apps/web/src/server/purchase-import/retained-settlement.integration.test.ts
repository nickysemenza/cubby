import type {
  FinancialAccountId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import { commitPurchaseImportInput } from "@cubby/schemas/purchase-import";
import { eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  financialTransactionAllocation,
  inventoryEntry,
  merchantVendorRule,
  purchase,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import { startImportRunFixture } from "./import-run.fixtures";
import { settleRetainedPaymentEvidence } from "./retained-settlement";

const checksum = (seed: number) => seed.toString(16).padStart(64, "0");

describe("settlement from retained order evidence", () => {
  const ctx = withTestDb();
  let seed = 0;

  async function world() {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Settlement member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `ForgeWear ${crypto.randomUUID()}`,
      website: "https://shop.example.test",
      browserDomains: ["shop.example.test"],
    });
    const account = await insertWithShortcode(ctx.db, "vendorAccount", {
      label: "Settlement vendor account",
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Settlement card",
      identity: { kind: "credit_card", issuer: null, network: "visa" },
      ledgerPartyId: party.id,
    });
    // Each order is imported by its own member Run: a commit settles the Run.
    const run = { ledgerPartyId: party.id, vendorAccountId: account.id };
    return { party, vendor, account, card, run };
  }

  async function importOrder(
    scope: Parameters<typeof startImportRunFixture>[1],
    order: {
      orderId: string;
      total: number;
      payments: { amount: number; chargedAt: string }[];
      source?: string;
      /** The order page printed no grand total. */
      unprintedTotal?: boolean;
    },
  ) {
    seed += 2;
    const { id: runId } = await startImportRunFixture(ctx.db, {
      ...scope,
      trigger: "manual",
    });
    const stable = `order-${order.orderId}-${order.source ?? "browser"}`;
    await preparePurchaseImport(
      ctx.db,
      {
        _runExecution: {
          runId,
          operationId: `prepare:${stable}`,
          itemOperationIds: [`prepare-item:${stable}`],
        },
        orders: [
          {
            stableOrderId: stable,
            itemOperationId: `prepare-item:${stable}`,
            source: {
              kind: "vendor_export" as const,
              externalKey: `shop:${order.source ?? "browser"}:${order.orderId}`,
              checksum: checksum(seed),
            },
            evidenceChecksum: checksum(seed + 1),
            extractionRevision: "shop@fixture-1",
            extraction: {
              status: "ready" as const,
              candidate: {
                orderId: order.orderId,
                orderedAt: "2026-09-01T12:00:00.000Z",
                merchant: "ForgeWear",
                currency: "USD",
                printedGrandTotal: order.unprintedTotal ? null : order.total,
                lines: [
                  {
                    title: `ForgeWear item for ${order.orderId}`,
                    amount: order.total,
                    lineKind: "principal" as const,
                  },
                ],
                payments: order.payments,
                allShipmentsDelivered: false,
              },
            },
            lineIds: [`${stable}:line-1`],
            primaryDocumentImageId: null,
            screenshotImageId: null,
          },
        ],
      },
      ctx.actor,
    );
    await commitPurchaseImport(
      ctx.db,
      commitPurchaseImportInput.parse({
        _runExecution: { runId, operationId: `commit:${stable}` },
        prepareOperationId: `prepare:${stable}`,
        defaultTrade: "other",
        resolutions: [
          {
            stableOrderId: stable,
            stableLineId: `${stable}:line-1`,
            resolution: { kind: "new" as const },
          },
        ],
      }),
      ctx.actor,
    );
    const [row] = await getDb(ctx.db)
      .select({ id: purchase.id })
      .from(purchase)
      .where(eq(purchase.orderId, order.orderId));
    if (!row) throw new Error("Order import wrote no Purchase");
    return row.id;
  }

  async function charge(
    accountId: FinancialAccountId,
    input: {
      amount: number;
      postedDate: string;
      status?: "posted" | "pending" | "void" | "expected";
      merchant?: string;
    },
  ) {
    return insertWithShortcode(ctx.db, "financialTransaction", {
      accountId,
      kind: input.amount < 0 ? "refund" : "purchase",
      status: input.status ?? "posted",
      amount: input.amount,
      transactionDate: null,
      postedDate: input.postedDate,
      merchant: input.merchant ?? "FORGEWEAR",
    });
  }

  async function allocationsFor(purchaseIds: PurchaseId[]) {
    return getDb(ctx.db)
      .select({
        transactionId: financialTransactionAllocation.transactionId,
        purchaseId: financialTransactionAllocation.purchaseId,
        amount: financialTransactionAllocation.amount,
      })
      .from(financialTransactionAllocation)
      .where(inArray(financialTransactionAllocation.purchaseId, purchaseIds));
  }

  it("settles a statement charge that arrives after the order from the order's retained payment line", async () => {
    const { card, run } = await world();
    const purchaseId = await importOrder(run, {
      orderId: "FW-1001",
      total: 40,
      payments: [{ amount: 40, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    expect(await allocationsFor([purchaseId])).toEqual([]);

    const posted = await charge(card.id, {
      amount: 40,
      postedDate: "2026-09-03",
    });
    const inventoryBefore = await getDb(ctx.db).select().from(inventoryEntry);
    await expect(settleRetainedPaymentEvidence(ctx.db)).resolves.toMatchObject({
      allocated: 1,
    });
    expect(await allocationsFor([purchaseId])).toEqual([
      { transactionId: posted.id, purchaseId, amount: 40 },
    ]);
    // Settlement never changes stock.
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(
      inventoryBefore,
    );
    // Replaying the pass is a no-op.
    await expect(settleRetainedPaymentEvidence(ctx.db)).resolves.toMatchObject({
      allocated: 0,
    });
  });

  it("leaves a charge two unsettled orders could both claim for review", async () => {
    const { card, run } = await world();
    const first = await importOrder(run, {
      orderId: "FW-2001",
      total: 25,
      payments: [{ amount: 25, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    const second = await importOrder(run, {
      orderId: "FW-2002",
      total: 25,
      payments: [{ amount: 25, chargedAt: "2026-09-03T12:00:00.000Z" }],
    });
    await charge(card.id, { amount: 25, postedDate: "2026-09-03" });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([first, second])).toEqual([]);
  });

  it("never settles against a void or expected charge, or one mapped to another vendor", async () => {
    const { party, card, run } = await world();
    const otherVendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Other shop ${crypto.randomUUID()}`,
    });
    await getDb(ctx.db).insert(merchantVendorRule).values({
      ledgerPartyId: party.id,
      normalizedMerchant: "other shop",
      vendorId: otherVendor.id,
      confirmedByUserId: ctx.actor.userId,
    });
    await charge(card.id, {
      amount: 31,
      postedDate: "2026-09-03",
      status: "void",
    });
    await charge(card.id, {
      amount: 32,
      postedDate: "2026-09-03",
      status: "expected",
    });
    await charge(card.id, {
      amount: 33,
      postedDate: "2026-09-03",
      merchant: "Other Shop",
    });
    const purchases = [
      await importOrder(run, {
        orderId: "FW-3001",
        total: 31,
        payments: [{ amount: 31, chargedAt: "2026-09-02T12:00:00.000Z" }],
      }),
      await importOrder(run, {
        orderId: "FW-3002",
        total: 32,
        payments: [{ amount: 32, chargedAt: "2026-09-02T12:00:00.000Z" }],
      }),
      await importOrder(run, {
        orderId: "FW-3003",
        total: 33,
        payments: [{ amount: 33, chargedAt: "2026-09-02T12:00:00.000Z" }],
      }),
    ];
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor(purchases)).toEqual([]);
  });

  it("allocates a combined charge across orders whose own payment lines each name it", async () => {
    const { card, run } = await world();
    const combined = await charge(card.id, {
      amount: 50,
      postedDate: "2026-09-04",
    });
    const first = await importOrder(run, {
      orderId: "FW-4001",
      total: 20,
      payments: [{ amount: 50, chargedAt: "2026-09-03T12:00:00.000Z" }],
    });
    // Until the second order arrives, the first order's line overstates its
    // own total and nothing claims the rest: no settlement yet.
    expect(await allocationsFor([first])).toEqual([]);
    const second = await importOrder(run, {
      orderId: "FW-4002",
      total: 30,
      payments: [{ amount: 50, chargedAt: "2026-09-03T12:00:00.000Z" }],
    });
    expect(
      (await allocationsFor([first, second])).sort(
        (a, b) => a.amount - b.amount,
      ),
    ).toEqual([
      { transactionId: combined.id, purchaseId: first, amount: 20 },
      { transactionId: combined.id, purchaseId: second, amount: 30 },
    ]);
  });

  it("does not let an order without a printed total absorb a larger combined charge", async () => {
    const { card, run } = await world();
    await charge(card.id, { amount: 50, postedDate: "2026-09-04" });
    const purchaseId = await importOrder(run, {
      orderId: "FW-4101",
      total: 20,
      unprintedTotal: true,
      payments: [{ amount: 50, chargedAt: "2026-09-03T12:00:00.000Z" }],
    });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([]);
  });

  it("never treats orders whose totals merely add up to a charge as a group", async () => {
    const { card, run } = await world();
    await charge(card.id, { amount: 50, postedDate: "2026-09-04" });
    const purchases = [
      await importOrder(run, {
        orderId: "FW-5001",
        total: 20,
        payments: [],
      }),
      await importOrder(run, {
        orderId: "FW-5002",
        total: 30,
        payments: [],
      }),
    ];
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor(purchases)).toEqual([]);
  });

  it("ignores a same-amount card payment or transfer instead of failing the pass", async () => {
    const { card, run } = await world();
    await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: card.id,
      kind: "credit_card_payment",
      status: "posted",
      amount: 44,
      transactionDate: null,
      postedDate: "2026-09-03",
      merchant: "FORGEWEAR",
    });
    const purchaseId = await importOrder(run, {
      orderId: "FW-6001",
      total: 44,
      payments: [{ amount: 44, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    await expect(settleRetainedPaymentEvidence(ctx.db)).resolves.toMatchObject({
      allocated: 0,
      failed: 0,
    });
    expect(await allocationsFor([purchaseId])).toEqual([]);
  });

  it("leaves an order whose sources disagree about its payments for review", async () => {
    const { card, run } = await world();
    const purchaseId = await importOrder(run, {
      orderId: "FW-8001",
      total: 40,
      payments: [{ amount: 40, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    await importOrder(run, {
      orderId: "FW-8001",
      total: 40,
      source: "export",
      payments: [
        { amount: 20, chargedAt: "2026-09-02T12:00:00.000Z" },
        { amount: 20, chargedAt: "2026-09-02T12:00:00.000Z" },
      ],
    });
    await charge(card.id, { amount: 40, postedDate: "2026-09-03" });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([]);
  });

  it("treats a partly settled order with an open payment line as a competitor", async () => {
    const { card, run } = await world();
    const settledLeg = await charge(card.id, {
      amount: 30,
      postedDate: "2026-09-03",
    });
    const partly = await importOrder(run, {
      orderId: "FW-7001",
      total: 55,
      payments: [
        { amount: 30, chargedAt: "2026-09-02T12:00:00.000Z" },
        { amount: 25, chargedAt: "2026-09-02T12:00:00.000Z" },
      ],
    });
    // The second leg never arrived, so the order stays unsettled; record the
    // first leg by hand, as a reviewer would.
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: settledLeg.id,
      purchaseId: partly,
      amount: 30,
    });
    await charge(card.id, { amount: 25, postedDate: "2026-09-03" });
    const other = await importOrder(run, {
      orderId: "FW-7002",
      total: 25,
      payments: [{ amount: 25, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([other])).toEqual([]);
  });
});
