import {
  financialSpendingAdvice,
  financialSpendingSource,
} from "@cubby/schemas/financial-booking";
import type {
  FinancialAccountId,
  PurchaseId,
} from "@cubby/schemas/identifiers";
import { commitPurchaseImportInput } from "@cubby/schemas/purchase-import";
import { and, eq, inArray } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransaction } from "~/server/db/helpers";
import {
  financialTransactionAllocation,
  financialTransaction,
  inventoryEntry,
  merchantVendorRule,
  purchase,
  expense,
  importSourceClaim,
  purchasePaymentEvidence,
  sourceOrderObservation,
} from "~/server/db/schema";
import {
  previewFinancialSpending,
  commitFinancialSpending,
} from "~/server/domains/financial-transaction/repo/financial-spending";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { runFinding } from "~/server/testing/run-finding.fixtures";

import {
  commitPurchaseImport,
  preparePurchaseImport,
} from "../operations/import-orders";
import { startImportRunFixture } from "../service/import-run.fixtures";
import {
  planPurchaseRetainedSettlement,
  prepareRetainedSettlementDiscovery,
  settleRetainedPaymentEvidence,
} from "./retained-settlement";

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
      vendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const card = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Settlement card",
      identity: { kind: "credit_card", network: "visa" },
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
      payments: {
        amount: number;
        chargedAt: string;
        tender?: "card" | "stored_value" | "unknown";
      }[];
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

  // Complete retained receipt evidence can settle a pending charge once; posting
  // later must not allocate or book it a second time.
  it("settles a supported pending authorization and replays its posted revision", async () => {
    const { card, run } = await world();
    const pending = await charge(card.id, {
      amount: 27,
      postedDate: "2026-09-02",
      status: "pending",
    });
    const purchaseId = await importOrder(run, {
      orderId: "pending-order",
      total: 27,
      payments: [{ amount: 27, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    expect(await allocationsFor([purchaseId])).toEqual([
      { transactionId: pending.id, purchaseId, amount: 27 },
    ]);
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ status: "posted" })
      .where(eq(financialTransaction.id, pending.id));
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([
      { transactionId: pending.id, purchaseId, amount: 27 },
    ]);
  });

  it("holds a completely matched payment subset that does not conserve the order total", async () => {
    const { card, run } = await world();
    await charge(card.id, { amount: 20, postedDate: "2026-09-02" });
    const purchaseId = await importOrder(run, {
      orderId: "partial-retained-set",
      total: 40,
      payments: [{ amount: 20, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([]);
  });

  // Discovery must prove the entire retained set and the same combined group
  // before a prospective charge exists; it cannot fabricate allocations.
  it("plans a complete multi-charge set with a prospective charge without allocating", async () => {
    const { card, run, party } = await world();
    const purchaseId = await importOrder(run, {
      orderId: "prospective-multi",
      total: 50,
      payments: [
        { amount: 20, chargedAt: "2026-09-02T12:00:00.000Z" },
        { amount: 30, chargedAt: "2026-09-03T12:00:00.000Z" },
      ],
    });
    await charge(card.id, { amount: 20, postedDate: "2026-09-02" });
    const planned = await withTransaction(ctx.db, async (tx) => {
      const input = {
        purchaseId,
        ledgerPartyId: party.id,
        discovery: true,
        additionalCharges: [
          {
            id: "prospective",
            amount: 30,
            kind: "purchase",
            occurredAt: new Date("2026-09-03T12:00:00.000Z"),
            cardLastFours: [],
            storedValue: false,
            accountId: card.id,
          },
        ],
      } satisfies Parameters<typeof planPurchaseRetainedSettlement>[1];
      const standalone = await planPurchaseRetainedSettlement(tx, input);
      const discovery = await prepareRetainedSettlementDiscovery(tx, [
        purchaseId,
        purchaseId,
      ]);
      expect(
        await planPurchaseRetainedSettlement(tx, input, discovery),
      ).toEqual(standalone);
      // Facts are reusable across source charges; the resulting plans are not.
      const changed = {
        ...input,
        additionalCharges: input.additionalCharges.map((row) => ({
          ...row,
          amount: 31,
        })),
      };
      expect(await planPurchaseRetainedSettlement(tx, changed, discovery)).toBe(
        "incomplete",
      );
      expect(await planPurchaseRetainedSettlement(tx, changed)).toBe(
        "incomplete",
      );
      await tx
        .update(purchasePaymentEvidence)
        .set({ chargedAt: null })
        .where(eq(purchasePaymentEvidence.purchaseId, purchaseId));
      // Commit planning must ignore even a supplied discovery snapshot.
      expect(
        await planPurchaseRetainedSettlement(
          tx,
          { ...input, discovery: false },
          discovery,
        ),
      ).toBe("no_evidence");
      await tx
        .update(purchase)
        .set({ deletedAt: new Date() })
        .where(eq(purchase.id, purchaseId));
      const deleted = await prepareRetainedSettlementDiscovery(tx, [
        purchaseId,
      ]);
      expect(await planPurchaseRetainedSettlement(tx, input, deleted)).toBe(
        "no_evidence",
      );
      expect(await planPurchaseRetainedSettlement(tx, input)).toBe(
        "no_evidence",
      );
      return standalone;
    });
    expect(
      Array.isArray(planned)
        ? planned.map((entry) => entry.charge.amount).sort((a, b) => a - b)
        : planned,
    ).toEqual([20, 30]);
    expect(await allocationsFor([purchaseId])).toEqual([]);
  });

  it("retains stored payment evidence when an attachment preview changes the amount", async () => {
    const { card, vendor, run } = await world();
    const purchaseId = await importOrder(run, {
      orderId: "attachment-amount-preview",
      total: 50,
      payments: [
        { amount: 20, chargedAt: "2026-09-02T12:00:00.000Z" },
        { amount: 30, chargedAt: "2026-09-03T12:00:00.000Z" },
      ],
    });
    const stored = await charge(card.id, {
      amount: 20,
      postedDate: "2026-09-02",
    });
    await charge(card.id, { amount: 30, postedDate: "2026-09-03" });
    const plan = await previewFinancialSpending(
      ctx.db,
      {
        transactionId: stored.shortcode,
        advice: financialSpendingAdvice.parse({
          vendorName: vendor.name,
          vendorConfidence: "high",
          counterparty: "business",
        }),
      },
      {
        settlementRef: {
          source: "synthetic-bank",
          externalId: "attachment-amount-preview",
        },
        fields: { amount: 21 },
      },
    );
    expect(plan.candidates).toMatchObject([{ strength: "strong" }]);
    expect(await allocationsFor([purchaseId])).toEqual([]);
  });

  it("commits a prospective combined charge only once across the conserved retained group", async () => {
    const { card, vendor, run } = await world();
    const first = await importOrder(run, {
      orderId: "prospective-combined-first",
      total: 20,
      payments: [{ amount: 50, chargedAt: "2026-09-03T12:00:00.000Z" }],
    });
    const second = await importOrder(run, {
      orderId: "prospective-combined-second",
      total: 30,
      payments: [{ amount: 50, chargedAt: "2026-09-03T12:00:00.000Z" }],
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic retained group category",
    });
    const source = financialSpendingSource.parse({
      accountId: card.shortcode,
      kind: "purchase",
      status: "posted",
      amount: 50,
      transactionDate: null,
      postedDate: "2026-09-03",
      merchant: vendor.name,
      rawDescription: null,
      sourceRefs: [
        { source: "synthetic-bank", externalId: "retained-combined-source" },
      ],
    });
    const advice = financialSpendingAdvice.parse({
      vendorName: vendor.name,
      counterparty: "business",
      vendorConfidence: "high",
      spendingCategoryId: category.shortcode,
      categoryConfidence: "high",
    });
    const plan = await previewFinancialSpending(ctx.db, { source, advice });
    expect(plan.status).toBe("ready");
    const created = await createRepoEntity(ctx, "financialTransaction", source);
    await commitFinancialSpending(ctx.db, plan, ctx.actor, created.output.id);
    expect(
      (await allocationsFor([first, second]))
        .map((row) => row.amount)
        .sort((a, b) => a - b),
    ).toEqual([20, 30]);
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .orderBy(expense.cost),
    ).toEqual([{ cost: 20 }, { cost: 30 }]);
  });

  it("discovers an old refund original from retained refund evidence despite its positive settlement", async () => {
    const { card, vendor, run, party } = await world();
    const purchaseId = await importOrder(run, {
      orderId: "old-refund-original",
      total: 80,
      payments: [{ amount: 80, chargedAt: "2026-02-02T12:00:00.000Z" }],
    });
    await charge(card.id, { amount: 80, postedDate: "2026-02-02" });
    await settleRetainedPaymentEvidence(ctx.db);
    await getDb(ctx.db)
      .update(purchase)
      .set({ date: "2026-02-01" })
      .where(eq(purchase.id, purchaseId));
    const [retained] = await getDb(ctx.db)
      .select()
      .from(purchasePaymentEvidence)
      .where(eq(purchasePaymentEvidence.purchaseId, purchaseId));
    if (!retained) throw new Error("Expected retained source payment");
    await getDb(ctx.db)
      .insert(purchasePaymentEvidence)
      .values({
        purchaseId,
        sourceClaimId: retained.sourceClaimId,
        evidenceIndex: retained.evidenceIndex + 1,
        amount: -15,
        chargedAt: new Date("2026-09-03T12:00:00.000Z"),
        tender: retained.tender,
        cardLastFour: retained.cardLastFour,
      });
    await withTransaction(ctx.db, async (tx) => {
      const discovery = await prepareRetainedSettlementDiscovery(tx, [
        purchaseId,
      ]);
      const positive = {
        purchaseId,
        ledgerPartyId: party.id,
        discovery: true,
      };
      expect(
        await planPurchaseRetainedSettlement(tx, positive, discovery),
      ).toBe("already_allocated");
      expect(await planPurchaseRetainedSettlement(tx, positive)).toBe(
        "already_allocated",
      );
      const refundInput = {
        ...positive,
        additionalCharges: [
          {
            id: "prospective-refund",
            kind: "refund",
            amount: -15,
            occurredAt: new Date("2026-09-03T12:00:00.000Z"),
            cardLastFours: [],
            storedValue: false,
            accountId: card.id,
          },
        ],
      } satisfies Parameters<typeof planPurchaseRetainedSettlement>[1];
      const standalone = await planPurchaseRetainedSettlement(tx, refundInput);
      expect(standalone).toMatchObject([
        { next: [{ purchaseId, amount: -15 }] },
      ]);
      expect(
        await planPurchaseRetainedSettlement(tx, refundInput, discovery),
      ).toEqual(standalone);
    });
    const refund = await createRepoEntity(ctx, "financialTransaction", {
      accountId: card.shortcode,
      kind: "refund",
      status: "posted",
      amount: -15,
      postedDate: "2026-09-03",
      merchant: vendor.name,
      sourceRefs: [
        { source: "synthetic-bank", externalId: "old-original-refund" },
      ],
    });
    const category = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Synthetic old refund category",
    });
    const advice = financialSpendingAdvice.parse({
      vendorName: vendor.name,
      counterparty: "business",
      vendorConfidence: "high",
      spendingCategoryId: category.shortcode,
      categoryConfidence: "high",
    });
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: refund.output.id,
      advice,
    });
    expect(plan).toMatchObject({ status: "ready", effect: "create_aggregate" });
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      (await allocationsFor([purchaseId]))
        .map((row) => row.amount)
        .sort((a, b) => a - b),
    ).toEqual([-15, 80]);
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .orderBy(expense.cost),
    ).toEqual([{ cost: -15 }, { cost: 80 }]);
    await getDb(ctx.db)
      .insert(purchasePaymentEvidence)
      .values({
        purchaseId,
        sourceClaimId: retained.sourceClaimId,
        evidenceIndex: retained.evidenceIndex + 2,
        amount: -5,
        chargedAt: new Date("2026-09-10T12:00:00.000Z"),
        tender: retained.tender,
        cardLastFour: retained.cardLastFour,
      });
    const nextRefund = await createRepoEntity(ctx, "financialTransaction", {
      accountId: card.shortcode,
      kind: "refund",
      status: "posted",
      amount: -5,
      postedDate: "2026-09-10",
      merchant: vendor.name,
      sourceRefs: [
        { source: "synthetic-bank", externalId: "second-old-original-refund" },
      ],
    });
    const nextPlan = await previewFinancialSpending(ctx.db, {
      transactionId: nextRefund.output.id,
      advice,
    });
    expect(nextPlan.status).toBe("ready");
    await commitFinancialSpending(ctx.db, nextPlan, ctx.actor);
    expect(
      (await allocationsFor([purchaseId]))
        .map((row) => row.amount)
        .sort((a, b) => a - b),
    ).toEqual([-15, -5, 80]);
  });

  // Regression: a gift-card payment line has no card digits, and a missing
  // last four used to match any same-amount card charge in the window.
  it("settles a gift-card payment line only from the member's stored-value account", async () => {
    const { party, vendor, card, run } = await world();
    const giftCard = await insertWithShortcode(ctx.db, "financialAccount", {
      name: "Shop gift card",
      identity: { kind: "stored_value" },
      providerVendorId: vendor.id,
      ledgerPartyId: party.id,
    });
    const purchaseId = await importOrder(run, {
      orderId: "FW-1501",
      total: 13.59,
      payments: [
        {
          amount: 13.59,
          chargedAt: "2026-09-02T12:00:00.000Z",
          tender: "stored_value",
        },
      ],
    });
    await charge(card.id, { amount: 13.59, postedDate: "2026-09-02" });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([]);

    const debit = await charge(giftCard.id, {
      amount: 13.59,
      postedDate: "2026-09-02",
    });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([
      { transactionId: debit.id, purchaseId, amount: 13.59 },
    ]);
  });

  it("leaves a stored-value settlement unresolved when the provider has multiple balances", async () => {
    const { party, vendor, run } = await world();
    const balances = [];
    for (const name of ["Synthetic merchant credit", "Synthetic rewards"]) {
      const account = await createRepoEntity(ctx, "financialAccount", {
        name,
        identity: { kind: "stored_value" },
        providerVendorId: vendor.shortcode,
        ledgerPartyId: party.shortcode,
      });
      balances.push({ id: account.entityId });
    }
    const purchaseId = await importOrder(run, {
      orderId: "FW-AMBIGUOUS",
      total: 13.59,
      payments: [
        {
          amount: 13.59,
          chargedAt: "2026-09-02T12:00:00.000Z",
          tender: "stored_value",
        },
      ],
    });
    const [firstBalance] = balances;
    if (!firstBalance) throw new Error("Synthetic balance missing");
    await charge(firstBalance.id, { amount: 13.59, postedDate: "2026-09-02" });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([]);
  });

  it("learns a tender when the same source is read again, without a reconciliation finding", async () => {
    const { card, run } = await world();
    const purchaseId = await importOrder(run, {
      orderId: "FW-1601",
      total: 13.59,
      payments: [{ amount: 13.59, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    await importOrder(run, {
      orderId: "FW-1601",
      total: 13.59,
      payments: [
        {
          amount: 13.59,
          chargedAt: "2026-09-02T12:00:00.000Z",
          tender: "stored_value",
        },
      ],
    });
    const findings = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(
        and(eq(runFinding.entityId, purchaseId), eq(runFinding.status, "open")),
      );
    expect(findings).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ tender: purchasePaymentEvidence.tender })
        .from(purchasePaymentEvidence)
        .where(eq(purchasePaymentEvidence.purchaseId, purchaseId)),
    ).toEqual([{ tender: "stored_value" }]);
    // A reread lists split tender in another order: tender follows the facts,
    // not the position.
    const split = await importOrder(run, {
      orderId: "FW-1602",
      total: 13.59,
      payments: [
        { amount: 5, chargedAt: "2026-09-02T12:00:00.000Z" },
        { amount: 8.59, chargedAt: "2026-09-02T12:00:00.000Z" },
      ],
    });
    await importOrder(run, {
      orderId: "FW-1602",
      total: 13.59,
      payments: [
        { amount: 8.59, chargedAt: "2026-09-02T12:00:00.000Z", tender: "card" },
        {
          amount: 5,
          chargedAt: "2026-09-02T12:00:00.000Z",
          tender: "stored_value",
        },
      ],
    });
    expect(
      await getDb(ctx.db)
        .select({
          amount: purchasePaymentEvidence.amount,
          tender: purchasePaymentEvidence.tender,
        })
        .from(purchasePaymentEvidence)
        .where(eq(purchasePaymentEvidence.purchaseId, split))
        .orderBy(purchasePaymentEvidence.amount),
    ).toEqual([
      { amount: 5, tender: "stored_value" },
      { amount: 8.59, tender: "card" },
    ]);
    // Identical lines where only one is named stay ambiguous.
    const twins = await importOrder(run, {
      orderId: "FW-1603",
      total: 10,
      payments: [
        { amount: 5, chargedAt: "2026-09-02T12:00:00.000Z" },
        { amount: 5, chargedAt: "2026-09-02T12:00:00.000Z" },
      ],
    });
    await importOrder(run, {
      orderId: "FW-1603",
      total: 10,
      payments: [
        {
          amount: 5,
          chargedAt: "2026-09-02T12:00:00.000Z",
          tender: "stored_value",
        },
        { amount: 5, chargedAt: "2026-09-02T12:00:00.000Z" },
      ],
    });
    expect(
      await getDb(ctx.db)
        .selectDistinct({ tender: purchasePaymentEvidence.tender })
        .from(purchasePaymentEvidence)
        .where(eq(purchasePaymentEvidence.purchaseId, twins)),
    ).toEqual([{ tender: "unknown" }]);
    await charge(card.id, { amount: 13.59, postedDate: "2026-09-02" });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([]);
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

  it("preserves source conflicts and payment multiplicity when discovery facts share a page", async () => {
    const { party, run, card } = await world();
    const twins = await importOrder(run, {
      orderId: "discovery-twins",
      total: 10,
      payments: [
        { amount: 5, chargedAt: "2026-09-02T12:00:00.000Z", tender: "card" },
        { amount: 5, chargedAt: "2026-09-02T12:00:00.000Z", tender: "card" },
      ],
    });
    const conflicting = await importOrder(run, {
      orderId: "discovery-conflict",
      total: 40,
      payments: [
        { amount: 40, chargedAt: "2026-09-02T12:00:00.000Z", tender: "card" },
      ],
    });
    await importOrder(run, {
      orderId: "discovery-conflict",
      source: "export",
      total: 40,
      payments: [
        {
          amount: 40,
          chargedAt: "2026-09-02T12:00:00.000Z",
          tender: "stored_value",
        },
      ],
    });
    const [exportClaim] = await getDb(ctx.db)
      .select({ id: importSourceClaim.id })
      .from(importSourceClaim)
      .where(
        and(
          eq(importSourceClaim.ledgerPartyId, party.id),
          eq(importSourceClaim.externalKey, "shop:export:discovery-conflict"),
        ),
      );
    if (!exportClaim) throw new Error("Expected imported export source claim");
    // Normal intake holds conflicting sources for review. Reproduce retained
    // historical disagreement only after creating both supported sources.
    await getDb(ctx.db)
      .insert(purchasePaymentEvidence)
      .values({
        purchaseId: conflicting,
        sourceClaimId: exportClaim.id,
        evidenceIndex: 0,
        amount: 40,
        chargedAt: new Date("2026-09-02T12:00:00.000Z"),
        tender: "stored_value",
      })
      .onConflictDoNothing();
    await withTransaction(ctx.db, async (tx) => {
      const discovery = await prepareRetainedSettlementDiscovery(tx, [
        twins,
        conflicting,
      ]);
      // Two identical retained lines must not collapse into one payment.
      expect(discovery.get(twins)?.payments).toMatchObject([
        { amount: 5, tender: "card" },
        { amount: 5, tender: "card" },
      ]);
      const input = {
        purchaseId: twins,
        ledgerPartyId: party.id,
        discovery: true,
        additionalCharges: [
          {
            id: "prospective-single-twin",
            amount: 5,
            kind: "purchase",
            occurredAt: new Date("2026-09-02T12:00:00.000Z"),
            cardLastFours: [],
            storedValue: false,
            accountId: card.id,
          },
        ],
      } satisfies Parameters<typeof planPurchaseRetainedSettlement>[1];
      expect(await planPurchaseRetainedSettlement(tx, input, discovery)).toBe(
        "incomplete",
      );
      expect(await planPurchaseRetainedSettlement(tx, input)).toBe(
        "incomplete",
      );
      const conflictInput = { ...input, purchaseId: conflicting };
      expect(
        await planPurchaseRetainedSettlement(tx, conflictInput, discovery),
      ).toBe("conflicting_sources");
      expect(await planPurchaseRetainedSettlement(tx, conflictInput)).toBe(
        "conflicting_sources",
      );
    });
    expect(await allocationsFor([twins, conflicting])).toEqual([]);
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

  it("leaves disagreeing new payment evidence for review while settling only the accepted source", async () => {
    const { card, run } = await world();
    const purchaseId = await importOrder(run, {
      orderId: "FW-8001",
      total: 40,
      payments: [{ amount: 40, chargedAt: "2026-09-02T12:00:00.000Z" }],
    });
    const beforeExpenses = await getDb(ctx.db).select().from(expense);
    const beforePayments = await getDb(ctx.db)
      .select()
      .from(purchasePaymentEvidence);
    const beforeStock = await getDb(ctx.db).select().from(inventoryEntry);
    await importOrder(run, {
      orderId: "FW-8001",
      total: 40,
      source: "export",
      payments: [
        { amount: 20, chargedAt: "2026-09-02T12:00:00.000Z" },
        { amount: 20, chargedAt: "2026-09-02T12:00:00.000Z" },
      ],
    });
    expect(await getDb(ctx.db).select().from(expense)).toEqual(beforeExpenses);
    expect(await getDb(ctx.db).select().from(purchasePaymentEvidence)).toEqual(
      beforePayments,
    );
    const observations = await getDb(ctx.db)
      .select()
      .from(sourceOrderObservation);
    expect(observations).toHaveLength(2);
    expect(
      observations
        .map((row) => row.extraction.candidate?.payments.length)
        .sort(),
    ).toEqual([1, 2]);
    const findings = await getDb(ctx.db)
      .select()
      .from(runFinding)
      .where(
        and(
          eq(runFinding.entityId, purchaseId),
          eq(runFinding.status, "open"),
          eq(runFinding.kind, "other"),
        ),
      );
    expect(findings).toHaveLength(1);
    const posted = await charge(card.id, {
      amount: 40,
      postedDate: "2026-09-03",
    });
    await settleRetainedPaymentEvidence(ctx.db);
    expect(await allocationsFor([purchaseId])).toEqual([
      { transactionId: posted.id, purchaseId, amount: 40 },
    ]);
    expect(await getDb(ctx.db).select().from(inventoryEntry)).toEqual(
      beforeStock,
    );
    expect(await getDb(ctx.db).select().from(purchasePaymentEvidence)).toEqual(
      beforePayments,
    );
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
