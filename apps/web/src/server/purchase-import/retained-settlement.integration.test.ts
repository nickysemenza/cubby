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
  importHunt,
  inventoryEntry,
  merchantVendorRule,
  purchase,
} from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { commitPurchaseImport, preparePurchaseImport } from "./import-orders";
import {
  settleMatchedChargeGroups,
  settleRetainedPaymentEvidence,
} from "./retained-settlement";
import { startOrResumeRun } from "./run-service";

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
    const run = await startOrResumeRun(ctx.db, {
      ledgerPartyId: party.id,
      vendorAccountId: account.id,
      trigger: "manual",
    });
    return { party, vendor, account, card, run };
  }

  async function importOrder(
    runId: string,
    order: {
      orderId: string;
      total: number;
      payments: { amount: number; chargedAt: string }[];
    },
  ) {
    seed += 2;
    const stable = `order-${order.orderId}`;
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
              kind: "browser_order" as const,
              externalKey: `shop:order:${order.orderId}`,
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
                printedGrandTotal: order.total,
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
    const purchaseId = await importOrder(run.id, {
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
    const first = await importOrder(run.id, {
      orderId: "FW-2001",
      total: 25,
      payments: [{ amount: 25, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    const second = await importOrder(run.id, {
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
      await importOrder(run.id, {
        orderId: "FW-3001",
        total: 31,
        payments: [{ amount: 31, chargedAt: "2026-09-02T12:00:00.000Z" }],
      }),
      await importOrder(run.id, {
        orderId: "FW-3002",
        total: 32,
        payments: [{ amount: 32, chargedAt: "2026-09-02T12:00:00.000Z" }],
      }),
      await importOrder(run.id, {
        orderId: "FW-3003",
        total: 33,
        payments: [{ amount: 33, chargedAt: "2026-09-02T12:00:00.000Z" }],
      }),
    ];
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor(purchases)).toEqual([]);
  });

  it("allocates a combined charge across every matched order atomically once the last one is imported", async () => {
    const { party, vendor, account, card, run } = await world();
    const combined = await charge(card.id, {
      amount: 50,
      postedDate: "2026-09-04",
    });
    const [hunt] = await getDb(ctx.db)
      .insert(importHunt)
      .values({
        ledgerPartyId: party.id,
        financialTransactionId: combined.id,
        vendorId: vendor.id,
        vendorAccountId: account.id,
        state: "pending_browser",
        dateFrom: "2026-08-28",
        dateTo: "2026-09-11",
        matchedOrderIds: ["FW-4001", "FW-4002"],
      })
      .returning({ id: importHunt.id });

    const first = await importOrder(run.id, {
      orderId: "FW-4001",
      total: 20,
      payments: [],
    });
    await settleMatchedChargeGroups(ctx.db);
    expect(await allocationsFor([first])).toEqual([]);

    const second = await importOrder(run.id, {
      orderId: "FW-4002",
      total: 30,
      payments: [],
    });
    await expect(settleMatchedChargeGroups(ctx.db)).resolves.toMatchObject({
      allocated: 1,
    });
    expect(
      (await allocationsFor([first, second])).sort(
        (a, b) => a.amount - b.amount,
      ),
    ).toEqual([
      { transactionId: combined.id, purchaseId: first, amount: 20 },
      { transactionId: combined.id, purchaseId: second, amount: 30 },
    ]);
    const [resolved] = await getDb(ctx.db)
      .select({ state: importHunt.state })
      .from(importHunt)
      .where(eq(importHunt.id, hunt!.id));
    expect(resolved?.state).toBe("resolved");
  });

  it("leaves a combined charge unresolved when the matched orders' totals do not conserve it", async () => {
    const { party, vendor, account, card, run } = await world();
    const combined = await charge(card.id, {
      amount: 55,
      postedDate: "2026-09-04",
    });
    await getDb(ctx.db)
      .insert(importHunt)
      .values({
        ledgerPartyId: party.id,
        financialTransactionId: combined.id,
        vendorId: vendor.id,
        vendorAccountId: account.id,
        state: "pending_browser",
        dateFrom: "2026-08-28",
        dateTo: "2026-09-11",
        matchedOrderIds: ["FW-5001", "FW-5002"],
      });
    const purchases = [
      await importOrder(run.id, {
        orderId: "FW-5001",
        total: 20,
        payments: [],
      }),
      await importOrder(run.id, {
        orderId: "FW-5002",
        total: 30,
        payments: [],
      }),
    ];
    await settleMatchedChargeGroups(ctx.db);
    expect(await allocationsFor(purchases)).toEqual([]);
  });
});
