import {
  financialBookingInput,
  financialSpendingAdvice,
  financialSpendingSource,
} from "@cubby/schemas/financial-booking";
import { eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import {
  getDb,
  databaseForTransaction,
  withSnapshotWrite,
} from "~/server/db/helpers";
import {
  expense,
  purchase,
  financialAccount,
  ledgerParty,
  financialTransaction as transactionTable,
  financialTransactionAllocation,
  spendingCategory,
  vendor as vendorTable,
} from "~/server/db/schema";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  previewFinancialBooking,
  commitFinancialBooking,
} from "./financial-booking";
import {
  previewFinancialSpending,
  commitFinancialSpending,
  prepareFinancialSpendingPage,
  prepareFinancialSpendingCandidates,
  financialSpendingCategoryHistory,
} from "./financial-spending";
import { updateFinancialTransaction } from "./financial-transaction";

// Failure modes: accepting bank evidence adds zero spend; retries mint another
// Expense; a nearby receipt is double-booked; a missing owner or an unmatched
// refund silently passes; unknown posting status blocks classified spending.
describe("shared spending booking", () => {
  const ctx = withTestDb();
  async function fixture(sharedCard = false) {
    const owner = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic spending member",
      kind: "member",
    });
    const household = sharedCard
      ? await createRepoIdentity(ctx, "ledgerParty", {
          name: "Synthetic shared funds",
          kind: "household",
        })
      : null;
    const account = await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic spending account",
      identity: sharedCard
        ? { kind: "credit_card", issuer: "Example Bank", network: "visa" }
        : { kind: "cash" },
      ledgerPartyId: household?.output.id ?? owner.output.id,
      primaryCardholderId: sharedCard ? owner.output.id : null,
      provisional: false,
    });
    const vendor = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic Orchard",
    });
    const category = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      {
        name: "Synthetic groceries",
      },
    );
    const transaction = await createRepoIdentity(ctx, "financialTransaction", {
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
  it.each(["spending", "direct"] as const)(
    "books a household card's sole live member once through %s booking",
    async (writer) => {
      const { owner, account, transaction, vendor, category, advice } =
        await fixture(true);
      const request = { transactionId: transaction.output.id, advice };
      const page = await prepareFinancialSpendingPage(ctx.db, {
        accountIds: [account.entityId],
        transactionIds: [transaction.entityId],
      });
      const cached = await countTestDbQueries(() =>
        previewFinancialSpending(ctx.db, request, undefined, page),
      );
      expect(cached.tables).not.toContain("LedgerParty");
      const plan = await previewFinancialSpending(ctx.db, request);
      expect(cached.result).toEqual(plan);
      expect(plan).toMatchObject({
        status: "ready",
        purchaserId: owner.output.id,
      });
      const direct = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
          spendingCategoryId: category.id,
        }),
      );
      expect(direct).toMatchObject({
        purchaserId: owner.output.id,
        funderName: "Synthetic shared funds",
      });
      const commit =
        writer === "spending"
          ? () => commitFinancialSpending(ctx.db, plan, ctx.actor)
          : () => commitFinancialBooking(ctx.db, direct, ctx.actor);
      const booked = await commit();
      expect(booked).toMatchObject({ replayed: false });
      expect(await commit()).toMatchObject({ replayed: true });
      expect(
        await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
      ).toEqual([{ cost: 42.5 }]);
      expect(
        await getDb(ctx.db)
          .select({ purchaser: purchase.purchaserOverrideId })
          .from(purchase),
      ).toEqual([{ purchaser: owner.entityId }]);
    },
  );
  it.each([
    [null, null, false],
    ["2026-05-04", "2026-05-10", false],
    ["2026-04-01", "2026-05-04", false],
    [null, "2026-05-03", true],
    ["2026-05-05", null, true],
  ] as const)(
    "uses inclusive sole-access bounds %s through %s (ready=%s)",
    async (validFrom, validTo, ready) => {
      const { owner, account, transaction, vendor, category, advice } =
        await fixture(true);
      const other = await createRepoIdentity(ctx, "ledgerParty", {
        name: "Synthetic authorized member",
        kind: "member",
      });
      await getDb(ctx.db)
        .update(financialAccount)
        .set({
          authorizedUsers: [
            { ledgerPartyId: other.output.id, validFrom, validTo },
          ],
        })
        .where(eq(financialAccount.id, account.entityId));
      const request = { transactionId: transaction.output.id, advice };
      const page = await prepareFinancialSpendingPage(ctx.db, {
        accountIds: [account.entityId],
        transactionIds: [transaction.entityId],
      });
      const plan = await previewFinancialSpending(ctx.db, request);
      expect(
        await previewFinancialSpending(ctx.db, request, undefined, page),
      ).toEqual(plan);
      expect(plan.status).toBe(ready ? "ready" : "review_required");
      const direct = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
          spendingCategoryId: category.id,
        }),
      ).then(
        (review) => ({ purchaserId: review.purchaserId }),
        (error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const held = { error: expect.stringMatching(/live member purchaser/) };
      expect(direct).toEqual(ready ? { purchaserId: owner.output.id } : held);
    },
  );
  it("uses the projected posting date for sole access when the charge date is absent", async () => {
    const { owner, account, transaction, vendor, category, advice } =
      await fixture(true);
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      {
        transactionDate: null,
        postedDate: "2026-05-04",
      },
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(financialAccount)
      .set({
        authorizedUsers: [
          {
            ledgerPartyId: owner.output.id,
            validFrom: "2026-05-05",
            validTo: null,
          },
        ],
      })
      .where(eq(financialAccount.id, account.entityId));
    const request = { transactionId: transaction.output.id, advice };
    expect((await previewFinancialSpending(ctx.db, request)).status).toBe(
      "ready",
    );
    const page = await prepareFinancialSpendingPage(ctx.db, {
      accountIds: [account.entityId],
      transactionIds: [transaction.entityId],
      sources: [{ amount: 42.5, postedDate: "2026-05-05" }],
    });
    const attachment = {
      settlementRef: {
        source: "synthetic-bank",
        externalId: "synthetic-posted-source",
      },
      fields: { postedDate: "2026-05-05" },
    };
    const projected = await previewFinancialSpending(
      ctx.db,
      request,
      attachment,
    );
    expect(projected.status).toBe("review_required");
    expect(
      await previewFinancialSpending(ctx.db, request, attachment, page),
    ).toEqual(projected);
    await expect(
      previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
          spendingCategoryId: category.id,
        }),
        { postedDate: "2026-05-05" },
      ),
    ).rejects.toThrow(/live member purchaser/);
  });
  it("preserves live member owner precedence over shared card access", async () => {
    const { owner, account, transaction, vendor, category, advice } =
      await fixture(true);
    const other = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic other holder",
      kind: "member",
    });
    await getDb(ctx.db)
      .update(financialAccount)
      .set({
        ledgerPartyId: owner.entityId,
        primaryCardholderId: other.entityId,
        authorizedUsers: [
          { ledgerPartyId: owner.output.id, validFrom: null, validTo: null },
        ],
      })
      .where(eq(financialAccount.id, account.entityId));
    expect(
      await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      }),
    ).toMatchObject({ status: "ready", purchaserId: owner.output.id });
    const direct = await previewFinancialBooking(
      ctx.db,
      financialBookingInput.parse({
        transactionId: transaction.output.id,
        vendorId: vendor.output.id,
        spendingCategoryId: category.id,
      }),
    );
    expect(direct.purchaserId).toBe(owner.output.id);
    expect(
      await commitFinancialBooking(ctx.db, direct, ctx.actor),
    ).toMatchObject({ replayed: false });
    expect(
      await commitFinancialBooking(ctx.db, direct, ctx.actor),
    ).toMatchObject({ replayed: true });
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 42.5 }]);
  });
  it.each([
    "missing",
    "deleted",
    "nonmember",
    "provisional",
    "deleted-account",
    "noncard",
  ] as const)("holds a shared card with %s authority", async (state) => {
    const { owner, account, transaction, vendor, category, advice } =
      await fixture(true);
    if (state === "deleted" || state === "nonmember")
      await getDb(ctx.db)
        .update(ledgerParty)
        .set(
          state === "deleted" ? { deletedAt: new Date() } : { kind: "guest" },
        )
        .where(eq(ledgerParty.id, owner.entityId));
    else
      await getDb(ctx.db)
        .update(financialAccount)
        .set(
          state === "missing"
            ? { primaryCardholderId: null }
            : state === "provisional"
              ? { provisional: true }
              : state === "noncard"
                ? { identity: { kind: "cash" } }
                : { deletedAt: new Date() },
        )
        .where(eq(financialAccount.id, account.entityId));
    const spending = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    }).then(
      (plan) => plan.status,
      (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    );
    const missingAccount = expect.stringMatching(/no longer live/);
    expect(spending).toEqual(
      state === "deleted-account" ? missingAccount : "review_required",
    );
    await expect(
      previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
          spendingCategoryId: category.id,
        }),
      ),
    ).rejects.toThrow(/live member purchaser/);
    expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
  });
  it.each(["access", "holder"] as const)(
    "refuses changed sole-card %s before commit and accepted-plan replay",
    async (state) => {
      const { owner, account, transaction, vendor, category, advice } =
        await fixture(true);
      const request = { transactionId: transaction.output.id, advice };
      const plan = await previewFinancialSpending(ctx.db, request);
      expect(plan.status).toBe("ready");
      const direct = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
          spendingCategoryId: category.id,
        }),
      );
      const change = () =>
        state === "access"
          ? getDb(ctx.db)
              .update(financialAccount)
              .set({
                authorizedUsers: [
                  {
                    ledgerPartyId: owner.output.id,
                    validFrom: null,
                    validTo: null,
                  },
                ],
              })
              .where(eq(financialAccount.id, account.entityId))
          : getDb(ctx.db)
              .update(ledgerParty)
              .set({ deletedAt: new Date() })
              .where(eq(ledgerParty.id, owner.entityId));
      const restore = () =>
        state === "access"
          ? getDb(ctx.db)
              .update(financialAccount)
              .set({ authorizedUsers: [] })
              .where(eq(financialAccount.id, account.entityId))
          : getDb(ctx.db)
              .update(ledgerParty)
              .set({ deletedAt: null })
              .where(eq(ledgerParty.id, owner.entityId));
      await change();
      await expect(
        commitFinancialSpending(ctx.db, plan, ctx.actor),
      ).rejects.toThrow(/changed|review/i);
      await expect(
        commitFinancialBooking(ctx.db, direct, ctx.actor),
      ).rejects.toThrow(/changed|review|not found/i);
      expect(await getDb(ctx.db).select().from(expense)).toEqual([]);
      await restore();
      await commitFinancialSpending(
        ctx.db,
        await previewFinancialSpending(ctx.db, request),
        ctx.actor,
      );
      await change();
      await expect(
        commitFinancialSpending(ctx.db, plan, ctx.actor),
      ).rejects.toThrow(/changed|review/i);
      expect(
        await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
      ).toEqual([{ cost: 42.5 }]);
    },
  );
  it("keeps complete spending previews identical with page-loaded receipt graphs", async () => {
    const { account, vendor, transaction, advice, category } = await fixture();
    for (const [date, cost] of [
      ["2026-05-04", 42.5],
      ["2026-05-06", 19],
    ] as const) {
      const receipt = await createRepoIdentity(ctx, "purchase", {
        vendorId: vendor.output.id,
        date,
        statedTotal: cost,
      });
      await createRepoIdentity(ctx, "expense", {
        purchaseId: receipt.output.id,
        name: "Synthetic receipt line",
        cost,
        date,
        trade: "other",
        spendingCategoryId: category.id,
      });
    }
    const page = await prepareFinancialSpendingPage(ctx.db, {
      accountIds: [
        await resolveOrThrow(ctx.db, "financialAccount", account.output.id),
      ],
      transactionIds: [
        await resolveOrThrow(
          ctx.db,
          "financialTransaction",
          transaction.output.id,
        ),
      ],
      sources: [
        {
          amount: 42.5,
          transactionDate: "2026-05-04",
          merchant: "Synthetic Orchard",
          kind: "purchase",
        },
      ],
    });
    await prepareFinancialSpendingCandidates(ctx.db, page);
    const blocked = await countTestDbQueries(() =>
      previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
      }),
    );
    expect(blocked.result).toMatchObject({ status: "review_required" });
    expect(blocked.result.candidates).toHaveLength(2);
    expect(blocked.tables).not.toContain("ExpenseAttribution");
    expect(blocked.tables).not.toContain("Expense");
    const requests = [
      { transactionId: transaction.output.id, advice },
      {
        source: financialSpendingSource.parse({
          accountId: account.output.id,
          kind: "refund",
          status: "observed",
          amount: -19,
          transactionDate: "2026-05-06",
          postedDate: null,
          rawDescription: null,
          merchant: "Synthetic Orchard",
          sourceRefs: [
            { source: "synthetic-bank", externalId: "synthetic-refund" },
          ],
        }),
        advice,
      },
    ];
    for (const request of requests)
      expect(
        await previewFinancialSpending(ctx.db, request, undefined, page),
      ).toEqual(await previewFinancialSpending(ctx.db, request));
  });
  it("shares category reads within an advisory page and rebuilds them before commit", async () => {
    const { account, transaction, advice, category } = await fixture();
    const accountId = await resolveOrThrow(
      ctx.db,
      "financialAccount",
      account.output.id,
    );
    const transactionId = await resolveOrThrow(
      ctx.db,
      "financialTransaction",
      transaction.output.id,
    );
    const prepare = () =>
      prepareFinancialSpendingPage(ctx.db, {
        accountIds: [accountId],
        transactionIds: [transactionId],
        sources: [{ amount: 42.5, transactionDate: "2026-05-04" }],
      });
    const request = {
      source: financialSpendingSource.parse({
        accountId: account.output.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        transactionDate: "2026-05-04",
        postedDate: null,
        rawDescription: null,
        merchant: "Synthetic Orchard",
        sourceRefs: [
          { source: "synthetic-bank", externalId: "synthetic-page-category" },
        ],
      }),
      advice,
    };
    const page = await prepare();
    const categoryReads = vi.spyOn(
      getDb(ctx.db).query.spendingCategory,
      "findFirst",
    );
    const shared = await Promise.all(
      Array.from({ length: 4 }, () =>
        previewFinancialSpending(ctx.db, request, undefined, page),
      ),
    );
    expect(categoryReads).toHaveBeenCalledTimes(1);
    categoryReads.mockRestore();
    const fresh = await previewFinancialSpending(ctx.db, request);
    expect(shared).toEqual(Array.from({ length: 4 }, () => fresh));
    expect(fresh.status).toBe("ready");

    const plan = await previewFinancialSpending(
      ctx.db,
      { transactionId: transaction.output.id, advice },
      undefined,
      page,
    );
    await getDb(ctx.db)
      .update(spendingCategory)
      .set({ name: "Synthetic renamed groceries" })
      .where(eq(spendingCategory.shortcode, category.id));
    // Advisory facts may be reused in this page, but never authorize a commit.
    await expect(
      commitFinancialSpending(ctx.db, plan, ctx.actor),
    ).rejects.toThrow(/changed/);
    const next = await previewFinancialSpending(
      ctx.db,
      request,
      undefined,
      await prepare(),
    );
    expect(next).toEqual(await previewFinancialSpending(ctx.db, request));
    expect(next.snapshot).not.toBe(fresh.snapshot);

    await getDb(ctx.db)
      .update(spendingCategory)
      .set({ deletedAt: new Date() })
      .where(eq(spendingCategory.shortcode, category.id));
    const missingPage = await prepare();
    const missingReads = vi.spyOn(
      getDb(ctx.db).query.spendingCategory,
      "findFirst",
    );
    const missing = await Promise.all(
      Array.from({ length: 4 }, () =>
        previewFinancialSpending(ctx.db, request, undefined, missingPage),
      ),
    );
    expect(missingReads).toHaveBeenCalledTimes(1);
    missingReads.mockRestore();
    expect(missing).toEqual(Array.from({ length: 4 }, () => missing[0]));
    expect(missing[0]).toEqual(await previewFinancialSpending(ctx.db, request));
    expect(missing[0]?.status).toBe("review_required");
  });
  it("counts effective Vendor history without future or deleted spending", async () => {
    const { vendor, category } = await fixture();
    const receipt = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
      spendingCategoryId: category.id,
    });
    for (const future of [false, false, true])
      await createRepoIdentity(ctx, "expense", {
        purchaseId: receipt.output.id,
        name: "Synthetic inherited history",
        cost: 10,
        trade: "other",
        future,
      });
    const deleted = await createRepoIdentity(ctx, "expense", {
      purchaseId: receipt.output.id,
      name: "Synthetic deleted history",
      cost: 10,
      trade: "other",
    });
    await getDb(ctx.db)
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(
        eq(
          expense.id,
          await resolveOrThrow(ctx.db, "expense", deleted.output.id),
        ),
      );
    const uncategorized = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
    });
    for (const lineKind of ["tax", "discount", "unclassified"] as const)
      await createRepoIdentity(ctx, "expense", {
        purchaseId: receipt.output.id,
        name: "Synthetic nonprincipal history",
        cost: lineKind === "discount" ? -1 : 0,
        lineKind,
        trade: "other",
      });
    await createRepoIdentity(ctx, "expense", {
      purchaseId: uncategorized.output.id,
      name: "Synthetic uncategorized history",
      cost: 7,
      trade: "other",
    });
    expect(
      await financialSpendingCategoryHistory(
        ctx.db,
        await resolveOrThrow(ctx.db, "vendor", vendor.output.id),
      ),
    ).toEqual([
      { category: null, name: null, lines: 4 },
      {
        category: await resolveOrThrow(ctx.db, "spendingCategory", category.id),
        name: "Synthetic groceries",
        lines: 2,
      },
    ]);
  });
  // Held identity and category conflicts need an explicit reviewed resolution;
  // ordinary high-confidence advice must never silently override either.
  it("requires review to choose an ambiguous Vendor and override conflicting category history", async () => {
    const { vendor, transaction, advice } = await fixture();
    await createRepoIdentity(ctx, "vendor", {
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
    const oldPurchase = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2025-01-01",
    });
    await createRepoIdentity(ctx, "expense", {
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
        const other = await createRepoIdentity(ctx, "ledgerParty", {
          name: "Synthetic changed owner",
          kind: "member",
        });
        await getDb(ctx.db)
          .update(financialAccount)
          .set({ ledgerPartyId: other.entityId })
          .where(eq(financialAccount.id, account.entityId));
      } else {
        const other = await createRepoIdentity(ctx, "vendor", {
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
    const receipt = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-01",
      statedTotal: 40,
    });
    await createRepoIdentity(ctx, "expense", {
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
    const created = await createRepoIdentity(
      ctx,
      "financialTransaction",
      source,
    );
    await commitFinancialSpending(ctx.db, plan, ctx.actor, created.output.id);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 19 }]);
  });
  // An attachment preview retains the real charge identity and may commit
  // only after its anticipated stable reference actually exists.
  it("previews an attachment reference on the real transaction and fences premature booking", async () => {
    const { transaction, advice } = await fixture();
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { sourceRefs: [] },
      ctx.actor,
    );
    const ref = {
      source: "synthetic-bank",
      externalId: "synthetic-attached-charge",
    };
    const plan = await previewFinancialSpending(
      ctx.db,
      { transactionId: transaction.output.id, advice },
      { settlementRef: ref },
    );
    expect(plan).toMatchObject({
      status: "ready",
      request: { transactionId: transaction.output.id },
    });
    await expect(
      commitFinancialSpending(ctx.db, plan, ctx.actor),
    ).rejects.toThrow("Spending evidence changed");
    await updateFinancialTransaction(
      ctx.db,
      transaction.output.id,
      { sourceRefs: [ref] },
      ctx.actor,
    );
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 42.5 }]);
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
  // A posting-status change must preserve the existing booking and its money.
  it("recognizes an already booked pending hold without duplicating Expenses", async () => {
    const { transaction, advice } = await fixture();
    const request = { transactionId: transaction.output.id, advice };
    const plan = await previewFinancialSpending(ctx.db, request);
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    await getDb(ctx.db)
      .update(transactionTable)
      .set({ status: "pending", postedDate: null })
      .where(eq(transactionTable.shortcode, transaction.output.id));
    const replay = await previewFinancialSpending(ctx.db, request);
    expect(replay.status).toBe("already_booked");
    await commitFinancialSpending(ctx.db, replay, ctx.actor);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 42.5 }]);
  });
  it("books pending and observed spending while deferring non-spending kinds", async () => {
    const { transaction, advice } = await fixture();
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
    const request = { transactionId: transaction.output.id, advice };
    for (const status of ["pending", "observed"] as const) {
      await updateFinancialTransaction(
        ctx.db,
        transaction.output.id,
        { status, kind: "purchase", amount: 42.5, postedDate: null },
        ctx.actor,
      );
      expect((await previewFinancialSpending(ctx.db, request)).status).toBe(
        "ready",
      );
    }
    await commitFinancialSpending(
      ctx.db,
      await previewFinancialSpending(ctx.db, request),
      ctx.actor,
    );
    const replay = await previewFinancialSpending(ctx.db, request);
    expect(replay.status).toBe("already_booked");
    await commitFinancialSpending(ctx.db, replay, ctx.actor);
    expect(
      await getDb(ctx.db).select({ cost: expense.cost }).from(expense),
    ).toEqual([{ cost: 42.5 }]);
    expect(
      await getDb(ctx.db)
        .select({
          status: transactionTable.status,
          postedDate: transactionTable.postedDate,
        })
        .from(transactionTable),
    ).toEqual([{ status: "observed", postedDate: null }]);
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
      await getDb(ctx.db)
        .select({ name: vendorTable.name })
        .from(vendorTable)
        .where(sql`${vendorTable.systemKey} IS NULL`),
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
    await createRepoIdentity(ctx, "purchase", {
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
    const competing = await createRepoIdentity(ctx, "vendor", {
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
    const receipt = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
    });
    await createRepoIdentity(ctx, "expense", {
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
    const receipt = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-05-04",
    });
    const line = await createRepoIdentity(ctx, "expense", {
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
    const next = await createRepoIdentity(ctx, "financialTransaction", {
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
    const receipt = await createRepoIdentity(ctx, "purchase", {
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
  it("uses an identified original's live category, excluding future and reimbursement lines, without fresh model advice", async () => {
    const { transaction, vendor, category, advice } = await fixture();
    const original = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2025-01-01",
    });
    await createRepoIdentity(ctx, "expense", {
      purchaseId: original.output.id,
      name: "Synthetic categorized original",
      cost: 100,
      trade: "other",
      spendingCategoryId: category.id,
    });
    const otherCategory = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      { name: "Synthetic future reimbursement category" },
    );
    await createRepoIdentity(ctx, "expense", {
      purchaseId: original.output.id,
      name: "Synthetic future item",
      cost: 200,
      future: true,
      trade: "other",
      spendingCategoryId: otherCategory.id,
    });
    await createRepoIdentity(ctx, "expense", {
      purchaseId: original.output.id,
      name: "Synthetic shared-cost repayment",
      cost: -20,
      economicRole: "reimbursement",
      trade: "other",
      spendingCategoryId: otherCategory.id,
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
    expect(lines.map((line) => line.cost)).toEqual([-20, -12, 100, 200]);
    expect(lines[1]?.category).toBe(lines[2]?.category);
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
    const original = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2025-05-01",
    });
    await createRepoIdentity(ctx, "expense", {
      purchaseId: original.output.id,
      name: "Synthetic original",
      cost: 100,
      trade: "other",
    });
    await createRepoIdentity(ctx, "expense", {
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
