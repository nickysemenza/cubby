import { and, eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted } from "~/server/db/helpers";
import { financialTransactionAllocation } from "~/server/db/schema";
import { applyFinancialSettlementAllocation } from "~/server/domains/financial-transaction/repo/financial-settlement-allocation";

import { proposeSettlementAllocations } from "./purchase-settlement-allocation";
import { listPurchaseSettlementCandidates } from "./purchase-settlement-candidates";

// SQL retrieval must not hide split/differently named evidence before a model
// can see it. Proposal defaults must preserve previously accepted split edges.
describe("settlement candidate graph preservation", () => {
  const ctx = withTestDb();
  it("retains prior allocations and offers only the residual for another order", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic wallet",
      identity: { kind: "cash" },
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic tools",
    });
    const prior = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
    });
    const target = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
      statedTotal: 30,
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 100,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-03",
      merchant: "Synthetic payment processor",
    });
    // A partially attached legacy graph is read evidence, never authority to
    // replace its already accepted allocation while completing the remainder.
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: transaction.entityId,
      purchaseId: prior.entityId,
      amount: 70,
    });
    const candidates = await listPurchaseSettlementCandidates(
      ctx.db,
      target.output.id,
    );
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          transactionId: transaction.output.id,
          merchantMatches: false,
          exactAmount: true,
        }),
      ]),
    );
    expect(
      proposeSettlementAllocations(
        target.output.id,
        {
          amount: 100,
          kind: "purchase",
          allocations: [{ purchaseId: prior.output.id, amount: 70 }],
        },
        { statedTotal: 30 },
      ),
    ).toEqual([
      { purchaseId: prior.output.id, amount: "70.00" },
      { purchaseId: target.output.id, amount: "30.00" },
    ]);
  });
  it("returns different-amount split alternatives but excludes transfer and distant evidence", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic card",
      identity: { kind: "cash" },
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic market",
    });
    const target = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
      statedTotal: 100,
    });
    const make = (
      amount: number,
      date: string,
      kind: "purchase" | "account_transfer",
    ) =>
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount,
        kind,
        status: "posted",
        postedDate: date,
        merchant: "Synthetic processor",
      });
    const first = await make(40, "2026-09-02", "purchase");
    const second = await make(60, "2026-09-03", "purchase");
    await make(100, "2026-09-02", "account_transfer");
    await make(100, "2026-12-01", "purchase");
    const candidates = await listPurchaseSettlementCandidates(
      ctx.db,
      target.output.id,
    );
    expect(candidates.map((row) => row.transactionId)).toEqual([
      first.output.id,
      second.output.id,
    ]);
  });
  it("ranks residual money before the cap and excludes fully allocated unrelated orders", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic allocation card",
      identity: { kind: "cash" },
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic allocation store",
    });
    const prior = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
    });
    const target = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-09-01",
      statedTotal: 30,
    });
    const full = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 30,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-01",
      allocations: [{ purchaseId: prior.output.id, amount: 30 }],
    });
    const partial = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 100,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-03",
      merchant: "Synthetic processor",
    });
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: partial.entityId,
      purchaseId: prior.entityId,
      amount: 70,
    });
    const candidates = await listPurchaseSettlementCandidates(
      ctx.db,
      target.output.id,
    );
    expect(candidates.map((row) => row.transactionId)).not.toContain(
      full.output.id,
    );
    expect(candidates[0]).toMatchObject({
      transactionId: partial.output.id,
      exactAmount: true,
    });
  });
  it("refuses a stale proposal without replacing a newly accepted unrelated edge", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic stale card",
      identity: { kind: "cash" },
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic stale store",
    });
    const first = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
    });
    const second = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
    });
    const third = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
    });
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      amount: 100,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-09-01",
      allocations: [{ purchaseId: first.output.id, amount: 100 }],
    });
    const priorAllocations = [{ purchaseId: first.output.id, amount: 100 }];
    await applyFinancialSettlementAllocation(
      ctx.db,
      {
        transactionId: transaction.output.id,
        priorAllocations,
        allocations: [
          { purchaseId: first.output.id, amount: 70 },
          { purchaseId: second.output.id, amount: 30 },
        ],
      },
      ctx.actor,
    );
    await expect(
      applyFinancialSettlementAllocation(
        ctx.db,
        {
          transactionId: transaction.output.id,
          priorAllocations,
          allocations: [
            { purchaseId: first.output.id, amount: 60 },
            { purchaseId: third.output.id, amount: 40 },
          ],
        },
        ctx.actor,
      ),
    ).rejects.toThrow("Settlement allocations changed");
    const saved = await getDb(ctx.db)
      .select({
        purchaseId: financialTransactionAllocation.purchaseId,
        amount: financialTransactionAllocation.amount,
      })
      .from(financialTransactionAllocation)
      .where(
        and(
          eq(
            financialTransactionAllocation.transactionId,
            transaction.entityId,
          ),
          notDeleted(financialTransactionAllocation),
        ),
      );
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(
      expect.arrayContaining([
        { purchaseId: first.entityId, amount: 70 },
        { purchaseId: second.entityId, amount: 30 },
      ]),
    );
  });
});
