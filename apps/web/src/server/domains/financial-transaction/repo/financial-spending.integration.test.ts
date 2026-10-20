import {
  financialSpendingAdvice,
  financialSpendingSource,
} from "@cubby/schemas/financial-booking";
import { eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoEntity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  getDb,
  databaseForTransaction,
  withSnapshotWrite,
} from "~/server/db/helpers";
import {
  expense,
  purchase,
  financialAccount,
  financialTransactionAllocation,
  vendor as vendorTable,
} from "~/server/db/schema";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  previewFinancialSpending,
  commitFinancialSpending,
} from "./financial-spending";
import { updateFinancialTransaction } from "./financial-transaction";

// Failure modes: accepting bank evidence adds zero spend; retries mint another
// Expense; a nearby receipt is double-booked; a missing owner or an unmatched
// refund silently passes; a pending hold books spending before it posts.
describe("shared spending booking", () => {
  const ctx = withTestDb();
  async function fixture() {
    const owner = await createRepoEntity(ctx, "ledgerParty", {
      name: "Synthetic spending member",
      kind: "member",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic spending account",
      identity: { kind: "cash" },
      ledgerPartyId: owner.output.id,
      provisional: false,
    });
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic Orchard",
    });
    const category = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      {
        name: "Synthetic groceries",
      },
    );
    const transaction = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      transactionDate: "2026-05-04",
      postedDate: "2026-05-05",
      merchant: "Synthetic Orchard",
      sourceRefs: [
        { source: "synthetic-bank", externalId: "synthetic-spending-1" },
      ],
    });
    const advice = financialSpendingAdvice.parse({
      spendingCategoryId: category.id,
      categoryConfidence: "high",
      vendorName: "Synthetic Orchard",
      vendorConfidence: "high",
      counterparty: "business",
    });
    return { owner, account, vendor, category, transaction, advice };
  }
  // Held identity and category conflicts need an explicit reviewed resolution;
  // ordinary high-confidence advice must never silently override either.
  it("requires review to choose an ambiguous Vendor and override conflicting category history", async () => {
    const { vendor, transaction, advice } = await fixture();
    await createRepoEntity(ctx, "vendor", {
      name: "Synthetic competing orchard",
      aliases: ["Synthetic Orchard"],
    });
    const oldCategory = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      {
        name: "Synthetic historic supplies",
      },
    );
    const oldPurchase = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2025-01-01",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: oldPurchase.output.id,
      name: "Synthetic prior supplies",
      cost: 20,
      trade: "other",
      spendingCategoryId: oldCategory.id,
    });
    const request = { transactionId: transaction.output.id, advice };
    expect((await previewFinancialSpending(ctx.db, request)).status).toBe(
      "review_required",
    );
    expect(
      (
        await previewFinancialSpending(ctx.db, {
          ...request,
          vendorId: vendor.output.id,
        })
      ).status,
    ).toBe("review_required");
    const reviewed = await previewFinancialSpending(ctx.db, {
      ...request,
      vendorId: vendor.output.id,
      categoryHistoryReviewed: true,
    });
    expect(reviewed.status).toBe("ready");
    await commitFinancialSpending(ctx.db, reviewed, ctx.actor);
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .orderBy(expense.cost),
    ).toEqual([{ cost: 20 }, { cost: 42.5 }]);
  });
  it("books one categorized Expense and the account owner, then replays without extra spend", async () => {
    const { owner, transaction, advice, category } = await fixture();
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    expect(plan.status).toBe("ready");
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    const replay = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    expect(replay.status).toBe("already_booked");
    await commitFinancialSpending(ctx.db, replay, ctx.actor);
    const result = await getDb(ctx.db).execute<{
      cost: number;
      category: string;
      owner: string;
    }>(sql`SELECT e.cost, c.shortcode AS category, lp.shortcode AS owner
      FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId"
      JOIN "SpendingCategory" c ON c.id = e."spendingCategoryId"
      JOIN "LedgerParty" lp ON lp.id = p."purchaserOverrideId"
      WHERE e."deletedAt" IS NULL`);
    expect(
      result.rows.map((row) => ({ ...row, cost: Number(row.cost) })),
    ).toEqual([{ cost: 42.5, category: category.id, owner: owner.output.id }]);
  });
  it.each(["owner", "vendor"])(
    "refuses an accepted plan replay after its %s identity changes",
    async (changed) => {
      const { account, transaction, advice } = await fixture();
      const plan = await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      });
      const saved = await commitFinancialSpending(ctx.db, plan, ctx.actor);
      if (!saved) throw new Error("Expected spending booking");
      if (changed === "owner") {
        const other = await createRepoEntity(ctx, "ledgerParty", {
          name: "Synthetic changed owner",
          kind: "member",
        });
        await getDb(ctx.db)
          .update(financialAccount)
          .set({ ledgerPartyId: other.entityId })
          .where(eq(financialAccount.id, account.entityId));
      } else {
        const other = await createRepoEntity(ctx, "vendor", {
          name: "Synthetic changed Vendor",
        });
        await getDb(ctx.db)
          .update(purchase)
          .set({ vendorId: other.entityId })
          .where(eq(purchase.shortcode, saved.purchaseIds[0]!));
      }
      await expect(
        commitFinancialSpending(ctx.db, plan, ctx.actor),
      ).rejects.toThrow(/identity|evidence changed/);
      expect(
        await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
      ).toEqual([{ cost: 42.5 }]);
    },
  );
  it("holds a nearby same-vendor Purchase instead of duplicating its spending", async () => {
    const { transaction, vendor, advice } = await fixture();
    const receipt = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-01",
      statedTotal: 40,
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: receipt.output.id,
      name: "Synthetic receipt",
      cost: 40,
      trade: "other",
    });
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    expect(plan.status).toBe("review_required");
    await expect(
      commitFinancialSpending(ctx.db, plan, ctx.actor),
    ).rejects.toThrow(/review/i);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 40 }]);
    expect(
      await getDb(ctx.db)
        .select({ name: purchase.displayLabel })
        .from(purchase),
    ).toHaveLength(1);
  });
  // A prospective source must survive creation without identity-only snapshot drift.
  it("commits a prospective source after creation using the same canonical snapshot", async () => {
    const { account, advice } = await fixture();
    const source = financialSpendingSource.parse({
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 19,
      transactionDate: "2026-08-04",
      postedDate: "2026-08-05",
      merchant: "Synthetic Orchard",
      rawDescription: null,
      sourceRefs: [
        { source: "synthetic-bank", externalId: "prospective-charge" },
      ],
    });
    const plan = await previewFinancialSpending(ctx.db, { source, advice });
    expect(plan.status).toBe("ready");
    const created = await createRepoEntity(ctx, "financialTransaction", source);
    await commitFinancialSpending(ctx.db, plan, ctx.actor, created.output.id);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 19 }]);
  });
  it("requires exactly one source style at the planning boundary", async () => {
    const { account, transaction, advice } = await fixture();
    const source = financialSpendingSource.parse({
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 19,
      transactionDate: "2026-08-04",
      postedDate: null,
      merchant: "Synthetic Orchard",
      rawDescription: null,
      sourceRefs: [],
    });
    await expect(
      previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        source,
        advice,
      }),
    ).rejects.toThrow(/Invalid input/);
    await expect(previewFinancialSpending(ctx.db, { advice })).rejects.toThrow(
      /Invalid input/,
    );
  });
  it("defers pending spending and non-spending kinds without creating Expenses", async () => {
    const { transaction, advice } = await fixture();
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { status: "pending" },
      ctx.actor,
    );
    expect(
      (
        await previewFinancialSpending(ctx.db, {
          transactionId: transaction.output.id,
          advice,
        })
      ).status,
    ).toBe("deferred");
    for (const kind of [
      "account_transfer",
      "credit_card_payment",
      "income",
    ] as const) {
      await updateFinancialTransaction(
        ctx.db,
        transaction.output.id,
        { status: "posted", kind, amount: kind === "income" ? -42.5 : 42.5 },
        ctx.actor,
      );
      expect(
        (
          await previewFinancialSpending(ctx.db, {
            transactionId: transaction.output.id,
            advice,
          })
        ).status,
      ).toBe("deferred");
    }
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
  it("books a posted fee through the shared writer", async () => {
    const { transaction, advice } = await fixture();
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { kind: "fee" },
      ctx.actor,
    );
    await commitFinancialSpending(
      ctx.db,
      await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      }),
      ctx.actor,
    );
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost, costType: expense.costType })
        .from(expense),
    ).toEqual([{ cost: 42.5, costType: "services" }]);
  });
  it("reuses an exact raw merchant Vendor when its proposed clean name is new", async () => {
    const { transaction, advice, vendor } = await fixture();
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice: { ...advice, vendorName: "Synthetic Orchard Market" },
    });
    expect(plan.status).toBe("ready");
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      await getDb(ctx.db).select({ name: vendorTable.name }).from(vendorTable),
    ).toEqual([{ name: "Synthetic Orchard" }]);
    const stored = await getDb(ctx.db).query.purchase.findFirst();
    expect(stored?.vendorId).toBe(
      await resolveOrThrow(ctx.db, "vendor", vendor.output.id),
    );
  });
  it("refuses a stale plan after a new plausible receipt appears", async () => {
    const { transaction, advice, vendor } = await fixture();
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
      statedTotal: 42.5,
    });
    await expect(
      commitFinancialSpending(ctx.db, plan, ctx.actor),
    ).rejects.toThrow(/changed|review/i);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
  it("creates a clean Vendor with the literal merchant alias atomically and refuses newly competing identity", async () => {
    const { transaction, advice } = await fixture();
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { merchant: "SYNTHETIC HARBOR 008" },
      ctx.actor,
    );
    const proposed = { ...advice, vendorName: "Synthetic Harbor" };
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice: proposed,
    });
    expect(plan.status).toBe("ready");
    const competing = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic Harbor",
      aliases: ["SYNTHETIC HARBOR 008"],
    });
    await expect(
      commitFinancialSpending(ctx.db, plan, ctx.actor),
    ).rejects.toThrow(/changed|review/i);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    const fresh = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice: proposed,
    });
    await commitFinancialSpending(ctx.db, fresh, ctx.actor);
    expect(
      await getDb(ctx.db).query.vendor.findFirst({
        where: eq(vendorTable.shortcode, competing.output.id),
      }),
    ).toMatchObject({ aliases: ["SYNTHETIC HARBOR 008"] });
  });
  it("rolls a newly created Vendor and alias back with spending, then creates both on success", async () => {
    const { transaction, advice } = await fixture();
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { merchant: "SYNTHETIC RIVER 009" },
      ctx.actor,
    );
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice: { ...advice, vendorName: "Synthetic River" },
    });
    expect(plan.status).toBe("ready");
    await expect(
      withSnapshotWrite(
        ctx.db,
        async (tx) => {
          await commitFinancialSpending(
            databaseForTransaction(tx),
            plan,
            ctx.actor,
          );
          throw new Error("Synthetic outer transaction refused");
        },
        { isolationLevel: "serializable" },
      ),
    ).rejects.toThrow("Synthetic outer transaction refused");
    expect(
      await getDb(ctx.db).query.vendor.findFirst({
        where: eq(vendorTable.name, "Synthetic River"),
      }),
    ).toBeUndefined();
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      await getDb(ctx.db).query.vendor.findFirst({
        where: eq(vendorTable.name, "Synthetic River"),
      }),
    ).toMatchObject({
      aliases: ["SYNTHETIC RIVER 009"],
      defaultSpendingCategoryId: null,
    });
  });
  it("does not call a fully allocated but underpriced receipt already booked", async () => {
    const { transaction, advice, vendor } = await fixture();
    const receipt = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: receipt.output.id,
      name: "Synthetic short receipt",
      cost: 1,
      trade: "other",
    });
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { allocations: [{ purchaseId: receipt.output.id, amount: 42.5 }] },
      ctx.actor,
    );
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    expect(plan.status).toBe("review_required");
  });
  it("does not prove booked spending with unpriced or unclassified Expense lines", async () => {
    const { transaction, advice, vendor } = await fixture();
    const receipt = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
    });
    const line = await createRepoEntity(ctx, "expense", {
      purchaseId: receipt.output.id,
      name: "Synthetic unresolved receipt",
      cost: null,
      trade: "other",
    });
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { allocations: [{ purchaseId: receipt.output.id, amount: 42.5 }] },
      ctx.actor,
    );
    expect(
      (
        await previewFinancialSpending(ctx.db, {
          transactionId: transaction.output.id,
          advice,
        })
      ).status,
    ).toBe("review_required");
    await getDb(ctx.db)
      .update(expense)
      .set({ cost: 42.5, lineKind: "unclassified" })
      .where(eq(expense.shortcode, line.output.id));
    expect(
      (
        await previewFinancialSpending(ctx.db, {
          transactionId: transaction.output.id,
          advice,
        })
      ).status,
    ).toBe("review_required");
  });
  it("refuses changed account ownership after preview without creating spending", async () => {
    const { account, transaction, advice } = await fixture();
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    await getDb(ctx.db)
      .update(financialAccount)
      .set({ provisional: true })
      .where(eq(financialAccount.shortcode, account.output.id));
    await expect(
      commitFinancialSpending(ctx.db, plan, ctx.actor),
    ).rejects.toThrow(/changed|review/i);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
  it("does not create another positive aggregate against a reviewed settled Purchase", async () => {
    const { account, transaction, advice } = await fixture();
    const initial = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    const saved = await commitFinancialSpending(ctx.db, initial, ctx.actor);
    if (!saved) throw new Error("Expected booking");
    const next = await createRepoEntity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 42.5,
      transactionDate: "2026-05-04",
      postedDate: "2026-05-04",
      merchant: "Synthetic Orchard",
      sourceRefs: [
        { source: "synthetic-bank", externalId: "duplicate-looking-charge" },
      ],
    });
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: next.output.id,
      advice,
      purchaseId: saved.purchaseIds[0],
    });
    expect(plan.status).toBe("review_required");
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 42.5 }]);
  });
  it("allows a reviewed empty Purchase to receive exactly one conserved aggregate", async () => {
    const { transaction, advice, vendor } = await fixture();
    const receipt = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
      statedTotal: 42.5,
    });
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
      purchaseId: receipt.output.id,
    });
    expect(plan).toMatchObject({
      status: "ready",
      effect: "create_aggregate",
      purchaseId: receipt.output.id,
    });
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 42.5 }]);
  });
  it("uses an identified original's live category for its negative Expense without fresh model advice", async () => {
    const { transaction, vendor, category, advice } = await fixture();
    const original = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2025-01-01",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: original.output.id,
      name: "Synthetic categorized original",
      cost: 100,
      trade: "other",
      spendingCategoryId: category.id,
    });
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { kind: "refund", amount: -12 },
      ctx.actor,
    );
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      purchaseId: original.output.id,
      advice: {
        ...advice,
        spendingCategoryId: null,
        categoryConfidence: "low",
      },
    });
    expect(plan).toMatchObject({
      status: "ready",
      spendingCategoryId: category.id,
    });
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    const lines = await getDb(ctx.db)
      .select({ cost: expense.cost, category: expense.spendingCategoryId })
      .from(expense)
      .orderBy(expense.cost);
    expect(lines.map((line) => line.cost)).toEqual([-12, 100]);
    expect(lines[0]?.category).toBe(lines[1]?.category);
  });
  it("holds unmatched refunds and reuses a reviewed old original's negative line", async () => {
    const { transaction, advice, vendor } = await fixture();
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { kind: "refund", amount: -12 },
      ctx.actor,
    );
    expect(
      (
        await previewFinancialSpending(ctx.db, {
          transactionId: transaction.output.id,
          advice,
        })
      ).status,
    ).toBe("review_required");
    const original = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2025-05-01",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: original.output.id,
      name: "Synthetic original",
      cost: 100,
      trade: "other",
    });
    await createRepoEntity(ctx, "expense", {
      purchaseId: original.output.id,
      name: "Synthetic refund",
      cost: -12,
      trade: "other",
    });
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
      purchaseId: original.output.id,
    });
    expect(plan.status).toBe("ready");
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      await getDb(ctx.db)
        .select({ cost: expense.cost })
        .from(expense)
        .orderBy(expense.cost),
    ).toEqual([{ cost: -12 }, { cost: 100 }]);
    expect(
      await getDb(ctx.db)
        .select({ amount: financialTransactionAllocation.amount })
        .from(financialTransactionAllocation),
    ).toEqual([{ amount: -12 }]);
  });
  it("books an unmatched refund standalone only after an explicit reviewed empty Purchase choice", async () => {
    const { transaction, advice } = await fixture();
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { kind: "refund", amount: -9 },
      ctx.actor,
    );
    const request = { transactionId: transaction.output.id, advice };
    expect((await previewFinancialSpending(ctx.db, request)).status).toBe(
      "review_required",
    );
    const reviewed = await previewFinancialSpending(ctx.db, {
      ...request,
      purchaseId: null,
    });
    expect(reviewed).toMatchObject({
      status: "ready",
      effect: "create_aggregate",
    });
    await commitFinancialSpending(ctx.db, reviewed, ctx.actor);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: -9 }]);
  });
});
