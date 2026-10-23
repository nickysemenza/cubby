import { SETTLEMENT_CANDIDATE_LIMIT } from "@cubby/schemas/financial-transaction";
import { and, eq } from "drizzle-orm";
import { createRepoEntity, createRepoIdentity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted } from "~/server/db/helpers";
import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { applyFinancialSettlementAllocation } from "~/server/domains/financial-transaction/repo/financial-settlement-allocation";

import { proposeSettlementAllocations } from "./purchase-settlement-allocation";
import {
  listPurchaseSettlementCandidates,
  listPurchasesSettlementCandidates,
} from "./purchase-settlement-candidates";

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
  it("returns split alternatives but excludes transfer, distant, void and deleted evidence", async () => {
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
      status: "posted" | "void" = "posted",
    ) =>
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount,
        kind,
        status,
        postedDate: date,
        merchant: "Synthetic processor",
      });
    const first = await make(40, "2026-09-02", "purchase");
    const second = await make(60, "2026-09-03", "purchase");
    await make(100, "2026-09-02", "account_transfer");
    await make(100, "2026-12-01", "purchase");
    await make(100, "2026-09-02", "purchase", "void");
    const deleted = await make(100, "2026-09-02", "purchase");
    await getDb(ctx.db)
      .update(financialTransaction)
      .set({ deletedAt: new Date() })
      .where(eq(financialTransaction.id, deleted.entityId));
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
    // More than a generic transaction page must not hide the later exact
    // residual. Keep this ranking population at the SQL boundary.
    for (let offset = 0; offset < 208; offset += 8)
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          createRepoIdentity(ctx, "financialTransaction", {
            accountId: account.output.id,
            amount: 1,
            kind: "purchase",
            status: "posted",
            postedDate: "2026-09-02",
            merchant: `Synthetic unrelated merchant ${offset + index}`,
          }),
        ),
      );
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
    expect(candidates).toHaveLength(SETTLEMENT_CANDIDATE_LIMIT);
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

  // Connection freshness ranks many Purchases at once. Each one's LATERAL
  // search must see only its own facts, keep its own order, and stop at its
  // own limit.
  it("ranks a batch of Purchases exactly as each alone", async () => {
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic batch card",
      identity: { kind: "cash" },
    });
    const [hardware, grocer] = await Promise.all([
      createRepoEntity(ctx, "vendor", { name: "Synthetic hardware" }),
      createRepoEntity(ctx, "vendor", { name: "Synthetic grocer" }),
    ]);
    const priced = await createRepoEntity(ctx, "purchase", {
      vendorId: hardware.output.id,
      date: "2026-09-10",
      statedTotal: 30,
    });
    const unpriced = await createRepoEntity(ctx, "purchase", {
      vendorId: grocer.output.id,
      date: "2026-09-12",
    });
    const undated = await createRepoEntity(ctx, "purchase", {
      vendorId: grocer.output.id,
    });
    for (let index = 0; index < 24; index++)
      await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount: index % 3 === 0 ? 30 : 10 + index,
        kind: "purchase",
        status: "posted",
        postedDate: `2026-09-${String(5 + (index % 15)).padStart(2, "0")}`,
        merchant:
          index % 2 === 0 ? "Synthetic hardware store" : "Synthetic grocer",
      });
    const codes = [priced.output.id, unpriced.output.id, undated.output.id];
    const batch = await listPurchasesSettlementCandidates(ctx.db, codes);
    for (const code of codes)
      expect(batch.get(code)).toEqual(
        await listPurchaseSettlementCandidates(ctx.db, code),
      );
    expect(batch.get(priced.output.id)).toHaveLength(
      SETTLEMENT_CANDIDATE_LIMIT,
    );
    expect(batch.get(priced.output.id)?.[0]).toMatchObject({
      exactAmount: true,
      merchantMatches: true,
    });
    expect(batch.get(unpriced.output.id)?.[0]).toMatchObject({
      exactAmount: false,
      merchantMatches: true,
    });
    expect(batch.get(undated.output.id)).toEqual([]);
  });
});
