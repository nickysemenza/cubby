import {
  financialBookingInput,
  financialSpendingAdvice,
  financialSpendingSource,
  financialSpendingPlan,
} from "@cubby/schemas/financial-booking";
import {
  type FinancialTransactionId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { contributionRole } from "@cubby/schemas/ledger-party";
import { eq, inArray, like, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { buildEntity } from "tooling/factories/build";
import { createEntity } from "tooling/factories/create";
import { createRepoIdentity } from "tooling/factories/repo";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expenseCostDollarsSql } from "~/server/db/computed/expense-aggregate-sql";
import {
  getDb,
  databaseForTransaction,
  withSnapshotWrite,
  withTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  auditLog,
  expense,
  expenseAttribution,
  financialEvidenceAlias,
  purchase,
  financialAccount,
  ledgerParty,
  financialTransaction as transactionTable,
  financialTransactionAllocation,
  spendingCategory,
  vendor as vendorTable,
} from "~/server/db/schema";
import { updateExpense } from "~/server/domains/expense/repo/crud";
import { updateFinancialAccount } from "~/server/domains/financial-account/repo/financial-account";
import { digestValue } from "~/server/domains/financial-transaction/policy/booking-fingerprint";
import { updateSeedBankTransaction } from "~/server/domains/financial-transaction/repo/bank.fixtures";
import {
  previewFinancialBooking,
  commitFinancialBooking,
  loadFinancialBookingLineage,
} from "~/server/domains/financial-transaction/repo/financial-booking";
import { updatePurchaseEventWhere } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { readPurchaseById } from "~/server/domains/purchase/repo/purchase";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { dollarExpenseColumns } from "~/server/testing/repo.fixtures";

import {
  previewFinancialSpending,
  commitFinancialSpending,
  commitFinancialSpendings,
  prepareFinancialSpendingPage,
  financialSpendingCategoryHistory,
} from "./financial-spending";
import {
  createFinancialTransaction,
  createFinancialTransactions,
  updateFinancialTransaction,
} from "./financial-transaction";

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
        ? { kind: "credit_card", network: "visa" }
        : { kind: "cash" },
      ledgerPartyId: household?.output.id ?? owner.output.id,
      primaryCardholderId: sharedCard ? owner.output.id : null,
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
  it("books supported household loan escrow with no purchaser and rejects other loan spending", async () => {
    const household = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic household",
      kind: "household",
    });
    const account = await createRepoIdentity(ctx, "financialAccount", {
      name: "Synthetic loan",
      identity: { kind: "loan" },
      ledgerPartyId: household.output.id,
    });
    const vendor = await createRepoIdentity(ctx, "vendor", {
      name: "Synthetic county",
    });
    const category = await createEntity(
      buildKernelContext(ctx.db, ctx.actor.userId),
      "spendingCategory",
      { name: "Synthetic property tax" },
    );
    const transaction = await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 250,
      postedDate: "2026-05-05",
      merchant: "Synthetic county",
      rawDescription: "COUNTY TAX PMT",
      sourceRefs: [{ source: "synthetic-bank", externalId: "escrow-tax" }],
    });
    const advice = financialSpendingAdvice.parse({
      vendorName: "Synthetic county",
      vendorConfidence: "high",
      counterparty: "business",
      spendingCategoryId: category.id,
      categoryConfidence: "high",
    });
    expect(
      await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      }),
    ).toMatchObject({ status: "review_required" });
    const payment = await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 250,
      postedDate: "2026-05-05",
      merchant: "Synthetic lender",
      rawDescription: "PAYMENT",
      sourceRefs: [{ source: "synthetic-bank", externalId: "loan-payment" }],
    });
    expect(
      await previewFinancialSpending(ctx.db, {
        transactionId: payment.output.id,
        advice: { ...advice, escrowDisbursement: true },
      }),
    ).toMatchObject({ status: "review_required" });
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice: { ...advice, escrowDisbursement: true },
      spendingCategoryId: category.id,
    });
    expect(plan).toMatchObject({
      status: "ready",
      purchaserId: null,
      vendorId: vendor.output.id,
    });
    const booked = await commitFinancialSpending(ctx.db, plan, ctx.actor);
    if (!booked) throw new Error("Expected escrow spending to be booked");
    const [saved] = await getDb(ctx.db)
      .select({ purchaserId: purchase.purchaserOverrideId })
      .from(purchase);
    expect(saved?.purchaserId).toBeNull();
    const refund = await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "refund",
      status: "posted",
      amount: -25,
      postedDate: "2026-06-05",
      merchant: "Synthetic county",
      rawDescription: "ESCROW REFUND",
      sourceRefs: [{ source: "synthetic-bank", externalId: "escrow-refund" }],
    });
    const refundPlan = await previewFinancialSpending(ctx.db, {
      transactionId: refund.output.id,
      purchaseId: booked.purchaseIds[0],
      advice: {
        ...advice,
        spendingCategoryId: null,
        categoryConfidence: "low",
      },
    });
    expect(refundPlan).toMatchObject({
      status: "ready",
      spendingCategoryId: category.id,
    });
    await commitFinancialSpending(ctx.db, refundPlan, ctx.actor);
    const lines = await getDb(ctx.db)
      .select({
        cost: expenseCostDollarsSql(),
        category: expense.spendingCategoryId,
      })
      .from(expense)
      .orderBy(expense.cost);
    expect(lines.map((line) => line.cost)).toEqual([-25, 250]);
    expect(lines[0]?.category).toBe(lines[1]?.category);
  });
  it("books the card issuer for a generic fee on each card", async () => {
    const owner = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic member",
      kind: "member",
    });
    for (const [index, name] of [
      "Synthetic issuer one",
      "Synthetic issuer two",
    ].entries()) {
      const issuer = await createRepoIdentity(ctx, "vendor", { name });
      const account = await createRepoIdentity(ctx, "financialAccount", {
        name: `Synthetic card ${index}`,
        identity: { kind: "credit_card", network: "visa" },
        ledgerPartyId: owner.output.id,
        providerVendorId: issuer.output.id,
      });
      const transaction = await createRepoIdentity(
        ctx,
        "financialTransaction",
        {
          accountId: account.output.id,
          kind: "fee",
          status: "posted",
          amount: 20 + index,
          postedDate: "2026-05-05",
          merchant: "Annual Membership Fee",
          sourceRefs: [
            { source: "synthetic-bank", externalId: `fee-${index}` },
          ],
        },
      );
      const plan = await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
      });
      expect(plan).toMatchObject({
        status: "ready",
        vendorId: issuer.output.id,
      });
      await commitFinancialSpending(ctx.db, plan, ctx.actor);
    }
    const purchases = await getDb(ctx.db)
      .select({ vendorId: purchase.vendorId })
      .from(purchase);
    expect(new Set(purchases.map((row) => row.vendorId)).size).toBe(2);
  });
  it.each(["missing", "uncertain", "conflicting"] as const)(
    "books supported spending once with an unknown %s category instead of guessing",
    async (categoryEvidence) => {
      const { transaction, advice } = await fixture();
      const request = {
        transactionId: transaction.output.id,
        advice: financialSpendingAdvice.parse({
          ...advice,
          spendingCategoryId:
            categoryEvidence === "missing" ? null : advice.spendingCategoryId,
          categoryConfidence:
            categoryEvidence === "uncertain" ? "medium" : "high",
          historyConflict: categoryEvidence === "conflicting",
        }),
      };
      const plan = await previewFinancialSpending(ctx.db, request);
      expect(plan).toMatchObject({
        status: "ready",
        spendingCategoryId: null,
      });
      await commitFinancialSpending(ctx.db, plan, ctx.actor);
      expect(
        await commitFinancialSpending(ctx.db, plan, ctx.actor),
      ).toMatchObject({
        replayed: true,
      });
      expect(
        await getDb(ctx.db)
          .select({
            cost: expenseCostDollarsSql(),
            category: expense.spendingCategoryId,
          })
          .from(expense),
      ).toEqual([{ cost: 42.5, category: null }]);
      expect(
        await getDb(ctx.db)
          .select({
            amount:
              sql<number>`${financialTransactionAllocation.amountMinor}::numeric / 100`.mapWith(
                Number,
              ),
          })
          .from(financialTransactionAllocation),
      ).toEqual([{ amount: 42.5 }]);
    },
  );
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
      const cached = await previewFinancialSpending(
        ctx.db,
        request,
        undefined,
        page,
      );
      const plan = await previewFinancialSpending(ctx.db, request);
      expect(cached).toEqual(plan);
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
        await getDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense),
      ).toEqual([{ cost: 42.5 }]);
      expect(
        await getDb(ctx.db)
          .select({ purchaser: purchase.purchaserOverrideId })
          .from(purchase),
      ).toEqual([{ purchaser: owner.entityId }]);
    },
  );
  it("uses inclusive sole-access bounds for open, active, expired and future access", async () => {
    const { owner, account, transaction, vendor, category, advice } =
      await fixture(true);
    const other = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic authorized member",
      kind: "member",
    });
    for (const [validFrom, validTo, ready] of [
      [null, null, false],
      ["2026-05-04", "2026-05-10", false],
      ["2026-04-01", "2026-05-04", false],
      [null, "2026-05-03", true],
      ["2026-05-05", null, true],
    ] as const) {
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
      expect(plan.status).toBe("ready");
      expect(plan).toMatchObject({
        purchaserId: ready ? owner.output.id : null,
      });
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
      expect(direct).toEqual({ purchaserId: ready ? owner.output.id : null });
    }
  });
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
    expect(projected).toMatchObject({ status: "ready", purchaserId: null });
    expect(
      await previewFinancialSpending(ctx.db, request, attachment, page),
    ).toEqual(projected);
    expect(
      await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
          spendingCategoryId: category.id,
        }),
        { postedDate: "2026-05-05" },
      ),
    ).toMatchObject({ purchaserId: null });
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
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
    ).toEqual([{ cost: 42.5 }]);
  });
  it.each([
    "missing",
    "deleted",
    "nonmember",
    "deleted-account",
    "noncard",
  ] as const)(
    "distinguishes household-card primary evidence from invalid %s authority",
    async (state) => {
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
        state === "deleted-account"
          ? missingAccount
          : ["missing", "deleted", "nonmember"].includes(state)
            ? "ready"
            : "review_required",
      );
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
      expect(direct).toEqual(
        ["missing", "deleted", "nonmember"].includes(state)
          ? { purchaserId: null }
          : held,
      );
      expect(
        await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
      ).toEqual([]);
    },
  );
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
      expect(
        await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
      ).toEqual([]);
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
        await getDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense),
      ).toEqual([{ cost: 42.5 }]);
    },
  );
  async function householdCard(shared = false, primary = true) {
    const setup = await fixture(true);
    const other = await createRepoIdentity(ctx, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
    });
    await updateFinancialAccount(
      ctx.db,
      setup.account.output.id,
      {
        primaryCardholderId: primary ? setup.owner.output.id : null,
        authorizedUsers: shared
          ? [
              {
                ledgerPartyId: other.output.id,
                validFrom: "2026-05-04",
                validTo: "2026-05-04",
              },
            ]
          : [],
      },
      ctx.actor,
    );
    return { ...setup, other };
  }
  it.each(["shared", "absent primary"])(
    "books a household card with %s as unknown and replays one Expense",
    async (mode) => {
      const { transaction, advice, vendor, category, other } =
        await householdCard(mode === "shared", mode !== "absent primary");
      const plan = await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      });
      expect(plan.status).toBe("ready");
      if (plan.status !== "ready") return;
      expect(plan.purchaserId).toBeNull();
      const withoutProof = financialSpendingPlan.parse({
        ...plan,
        purchaserSnapshot: undefined,
      });
      await expect(
        commitFinancialSpending(ctx.db, withoutProof, ctx.actor),
      ).rejects.toThrow(/proof is missing/);

      expect(
        financialSpendingPlan.parse(JSON.parse(JSON.stringify(plan))),
      ).toEqual(plan);
      const direct = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
          spendingCategoryId: category.id,
        }),
      );
      expect(direct.purchaserId).toBeNull();
      expect(direct).toMatchObject({
        candidateCategoryId: category.id,
        categoryOverride: category.id,
        effectiveCategory: { mode: "explicit", value: category.id },
      });
      const explicit = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
          purchaserId: other.output.id,
        }),
      );
      expect(explicit.purchaserId).toBe(other.output.id);
      expect(explicit).toMatchObject({
        categoryOverride: null,
        effectiveCategory: { value: null, mode: "none" },
      });

      await commitFinancialSpending(ctx.db, plan, ctx.actor);
      expect(
        await commitFinancialSpending(ctx.db, plan, ctx.actor),
      ).toMatchObject({ replayed: true });
      expect(
        await getDb(ctx.db)
          .select({ purchaserOverrideId: purchase.purchaserOverrideId })
          .from(purchase),
      ).toEqual([{ purchaserOverrideId: null }]);
      expect(
        await getDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense),
      ).toEqual([{ cost: 42.5 }]);
    },
  );
  it.each([
    ["spending", false],
    ["direct", true],
  ] as const)(
    "preserves a known receipt purchaser across different dates through %s settlement and exact replay (posted-only=%s)",
    async (writer, postedOnly) => {
      const { transaction, advice, vendor, category, other } =
        await householdCard(true);
      if (postedOnly)
        await updateFinancialTransaction(
          ctx.db,
          transaction.output.id,
          {
            transactionDate: null,
            postedDate: "2026-05-04",
          },
          ctx.actor,
        );
      const vendorAccount = await createRepoIdentity(ctx, "vendorAccount", {
        vendorId: vendor.output.id,
        ledgerPartyId: other.output.id,
      });
      const receipt = await createRepoIdentity(ctx, "purchase", {
        vendorId: vendor.output.id,
        vendorAccountId: vendorAccount.output.id,
        date: "2026-05-03",
        statedTotal: 42.5,
      });
      await createRepoIdentity(ctx, "expense", {
        purchaseId: receipt.output.id,
        name: "Synthetic receipt line",
        cost: 42.5,
        date: "2026-05-03",
        trade: "other",
        spendingCategoryId: category.id,
      });
      const expected = {
        purchaserId: other.output.id,
        purchaserOverrideId: null,
      };
      expect(await readPurchaseById(ctx.db, receipt.entityId)).toMatchObject(
        expected,
      );
      const plan = await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        purchaseId: receipt.output.id,
        advice,
      });
      expect(plan).toMatchObject({
        status: "ready",
        effect: "link_existing",
        purchaserId: null,
      });
      const classified = await previewFinancialSpending(ctx.db, {
        ...plan.request,
        costType: "services",
      });
      expect(classified).toMatchObject({
        status: "review_required",
        reason: expect.stringMatching(
          /Cost type applies only to a new aggregate/,
        ),
      });
      await expect(
        commitFinancialSpending(ctx.db, classified, ctx.actor),
      ).rejects.toThrow(/Cost type applies only to a new aggregate/);
      const direct = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          purchaseId: receipt.output.id,
          spendingCategoryId: category.id,
        }),
      );
      expect(direct.action).toBe("link_existing");
      expect(direct.existingCategories).toHaveLength(1);
      expect(direct.existingCategories?.[0]?.resolution.value).toBe(
        category.id,
      );
      await expect(
        previewFinancialBooking(ctx.db, {
          ...direct,
          spendingCategoryId: direct.categoryOverride,
          beneficiaries: [],
        }),
      ).rejects.toThrow(/Beneficiaries apply only to a new aggregate/);
      expect(
        await previewFinancialSpending(ctx.db, {
          ...plan.request,
          beneficiaries: [],
        }),
      ).toMatchObject({
        status: "review_required",
        reason: expect.stringMatching(/Beneficiaries apply only/),
      });
      const commit =
        writer === "spending"
          ? () => commitFinancialSpending(ctx.db, plan, ctx.actor)
          : () => commitFinancialBooking(ctx.db, direct, ctx.actor);
      expect(await commit()).toMatchObject({ replayed: false });
      expect(await readPurchaseById(ctx.db, receipt.entityId)).toMatchObject(
        expected,
      );
      expect(await commit()).toMatchObject({ replayed: true });
      expect(await readPurchaseById(ctx.db, receipt.entityId)).toMatchObject(
        expected,
      );
      expect(
        await getDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense),
      ).toEqual([{ cost: 42.5 }]);
    },
  );
  it.each(["missing owner", "guest owner", "deleted owner", "loan"])(
    "holds household purchaser admission for %s",
    async (mode) => {
      const { transaction, advice, account, other } = await householdCard(true);
      if (mode === "guest owner")
        await getDb(ctx.db)
          .update(ledgerParty)
          .set({ kind: "guest" })
          .where(eq(ledgerParty.id, other.entityId));
      if (mode === "deleted owner")
        await getDb(ctx.db).execute(
          sql`UPDATE "LedgerParty" SET "deletedAt"=now() WHERE id=(SELECT "ledgerPartyId" FROM "FinancialAccount" WHERE id=${account.entityId})`,
        );
      if (mode !== "deleted owner")
        await getDb(ctx.db)
          .update(financialAccount)
          .set({
            ...(mode === "missing owner" ? { ledgerPartyId: null } : {}),
            ...(mode === "guest owner"
              ? { ledgerPartyId: other.entityId }
              : {}),
            ...(mode === "loan"
              ? {
                  identity: { kind: "other" as const },
                  primaryCardholderId: null,
                  authorizedUsers: [],
                }
              : {}),
          })
          .where(eq(financialAccount.id, account.entityId));
      expect(
        await previewFinancialSpending(ctx.db, {
          transactionId: transaction.output.id,
          advice,
        }),
      ).toMatchObject({ status: "review_required" });
    },
  );
  it("refuses changed invalid primary evidence while the purchaser remains unknown", async () => {
    const { owner, transaction, advice } = await householdCard(true);
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ kind: "guest" })
      .where(eq(ledgerParty.id, owner.entityId));
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    expect(plan).toMatchObject({ status: "ready", purchaserId: null });
    await getDb(ctx.db)
      .update(ledgerParty)
      .set({ deletedAt: new Date() })
      .where(eq(ledgerParty.id, owner.entityId));
    await expect(
      commitFinancialSpending(ctx.db, plan, ctx.actor),
    ).rejects.toThrow(/changed/);
    expect(
      await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
    ).toEqual([]);
  });
  it.each([false, true])(
    "refuses null-to-null account/access changes, booked=%s",
    async (booked) => {
      const { transaction, advice, account } = await householdCard(true);
      const plan = await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      });
      expect(plan).toMatchObject({ status: "ready", purchaserId: null });
      if (booked) await commitFinancialSpending(ctx.db, plan, ctx.actor);
      await getDb(ctx.db)
        .update(financialAccount)
        .set({ authorizedUsers: [], primaryCardholderId: null })
        .where(eq(financialAccount.id, account.entityId));
      await expect(
        commitFinancialSpending(ctx.db, plan, ctx.actor),
      ).rejects.toThrow(/changed/);
      expect(
        await getDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense),
      ).toEqual(booked ? [{ cost: 42.5 }] : []);
    },
  );
  it.each([false, true])(
    "rejects direct unknown-purchaser access changes, booked=%s",
    async (booked) => {
      const { transaction, vendor, account } = await householdCard(true);
      const review = await previewFinancialBooking(
        ctx.db,
        financialBookingInput.parse({
          transactionId: transaction.output.id,
          vendorId: vendor.output.id,
        }),
      );
      if (booked) {
        await commitFinancialBooking(ctx.db, review, ctx.actor);
        await commitFinancialBooking(ctx.db, review, ctx.actor);
      }
      await getDb(ctx.db)
        .update(financialAccount)
        .set({ primaryCardholderId: null })
        .where(eq(financialAccount.id, account.entityId));
      await expect(
        commitFinancialBooking(ctx.db, review, ctx.actor),
      ).rejects.toThrow(/changed/);
      expect(
        await getDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense),
      ).toEqual(booked ? [{ cost: 42.5 }] : []);
    },
  );
  it("rechecks category evidence at commit and leaves deleted model categories unknown", async () => {
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
    const reviewed = { ...request, spendingCategoryId: category.id };
    const page = await prepare();
    const shared = await Promise.all(
      Array.from({ length: 4 }, () =>
        previewFinancialSpending(ctx.db, reviewed, undefined, page),
      ),
    );
    const fresh = await previewFinancialSpending(ctx.db, reviewed);
    expect(shared).toEqual(Array.from({ length: 4 }, () => fresh));
    expect(fresh.status).toBe("ready");

    const plan = await previewFinancialSpending(
      ctx.db,
      {
        transactionId: transaction.output.id,
        advice,
        spendingCategoryId: category.id,
      },
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
      reviewed,
      undefined,
      await prepare(),
    );
    expect(next).toEqual(await previewFinancialSpending(ctx.db, reviewed));
    expect(next.snapshot).not.toBe(fresh.snapshot);

    await getDb(ctx.db)
      .update(spendingCategory)
      .set({ deletedAt: new Date() })
      .where(eq(spendingCategory.shortcode, category.id));
    const missingPage = await prepare();
    const missing = await Promise.all(
      Array.from({ length: 4 }, () =>
        previewFinancialSpending(ctx.db, request, undefined, missingPage),
      ),
    );
    expect(missing).toEqual(Array.from({ length: 4 }, () => missing[0]));
    expect(missing[0]).toEqual(await previewFinancialSpending(ctx.db, request));
    expect(missing[0]).toMatchObject({
      status: "ready",
      spendingCategoryId: null,
    });
    expect(
      await previewFinancialSpending(ctx.db, {
        ...request,
        spendingCategoryId: category.id,
      }),
    ).toMatchObject({
      status: "review_required",
      reason: "The reviewed spending category is no longer live.",
    });
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
  // Category uncertainty may leave a booking uncategorized, but cannot resolve
  // Vendor ambiguity or override an explicitly reviewed category's history.
  it("keeps category conflicts uncategorized and requires review for Vendor identity and category overrides", async () => {
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
    const request = {
      transactionId: transaction.output.id,
      advice,
      // This category review has already excluded the older independent receipt.
      rejectedPurchaseIds: [oldPurchase.output.id],
    };
    expect((await previewFinancialSpending(ctx.db, request)).status).toBe(
      "review_required",
    );
    expect(
      await previewFinancialSpending(ctx.db, {
        ...request,
        vendorId: vendor.output.id,
      }),
    ).toMatchObject({ status: "ready", spendingCategoryId: null });
    expect(
      (
        await previewFinancialSpending(ctx.db, {
          ...request,
          vendorId: vendor.output.id,
          spendingCategoryId: advice.spendingCategoryId ?? undefined,
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
        .select({ cost: expenseCostDollarsSql() })
        .from(expense)
        .orderBy(expense.cost),
    ).toEqual([{ cost: 20 }, { cost: 42.5 }]);
  });
  it.each([undefined, "services"] as const)(
    "books one categorized Expense with cost type %s and replays without extra spend",
    async (costType) => {
      const { owner, transaction, advice, category } = await fixture();
      const beneficiaries =
        costType === undefined
          ? undefined
          : [
              { partyId: owner.output.id, weight: 2 },
              { partyId: null, weight: 1 },
            ];
      const plan = await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
        spendingCategoryId: category.id,
        ...(costType === undefined ? {} : { costType }),
        ...(beneficiaries === undefined ? {} : { beneficiaries }),
      });
      expect(plan.status).toBe("ready");
      expect(Object.hasOwn(plan.request, "costType")).toBe(
        costType !== undefined,
      );
      expect(
        financialSpendingPlan.parse(JSON.parse(JSON.stringify(plan))),
      ).toEqual(plan);
      await expect(
        commitFinancialSpending(
          ctx.db,
          { ...plan, request: { ...plan.request, costType: "tools" } },
          ctx.actor,
        ),
      ).rejects.toThrow(/Spending evidence changed/);
      await commitFinancialSpending(ctx.db, plan, ctx.actor);
      const repeated = await commitFinancialSpending(
        ctx.db,
        plan,
        ctx.actor,
      ).then(
        (result) => (result?.replayed ? "replayed" : "created"),
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      );
      expect(repeated).toMatch(
        beneficiaries === undefined
          ? /^replayed$/
          : /Spending evidence changed/,
      );
      const unknown = [{ partyId: null, weight: 1 }];
      const changedChoice = await previewFinancialSpending(ctx.db, {
        ...plan.request,
        beneficiaries: unknown,
      });
      expect(changedChoice.status).toBe("review_required");
      await expect(
        commitFinancialSpending(
          ctx.db,
          { ...plan, request: { ...plan.request, beneficiaries: unknown } },
          ctx.actor,
        ),
      ).rejects.toThrow(/Spending evidence changed/);
      const attribution = await getDb(ctx.db)
        .select({
          partyId: expenseAttribution.ledgerPartyId,
          weight: expenseAttribution.weight,
        })
        .from(expenseAttribution)
        .where(
          sql`${expenseAttribution.role} = ${contributionRole.enum.beneficiary} AND ${expenseAttribution.deletedAt} IS NULL`,
        )
        .orderBy(expenseAttribution.ledgerPartyId);
      expect(
        attribution.map((share) => ({
          ...share,
          weight: Number(share.weight),
        })),
      ).toEqual(
        beneficiaries === undefined
          ? []
          : [
              { partyId: owner.entityId, weight: 2 },
              { partyId: null, weight: 1 },
            ],
      );
      const replay = await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      });
      expect(replay.status).toBe("already_booked");
      await commitFinancialSpending(ctx.db, replay, ctx.actor);
      const [bookedExpense] = await getDb(ctx.db)
        .select({ shortcode: expense.shortcode })
        .from(expense)
        .where(eq(expense.bookingTransactionCode, transaction.output.id));
      const claimed = await updateExpense.read(
        ["sourceClaims"],
        ctx.db,
        parseShortcodeFor("expense", bookedExpense!.shortcode),
        {
          sourceClaims: [
            {
              source: "synthetic-booking",
              providerId: "synthetic-booking-claim",
              normalizedEvidence: {
                amount: 42.5,
                occurredOn: "2026-05-04",
                description: "Synthetic booked source",
                context: null,
                disambiguator: null,
              },
              reconciliation: { decision: "amounts_match" },
            },
          ],
        },
        ctx.actor,
      );
      expect(claimed.output).toMatchObject({
        sourceClaims: [{ targetAmountAtClaim: 42.5 }],
      });
      const lineage = await loadFinancialBookingLineage(
        ctx.db,
        transaction.output.id,
      );
      expect(digestValue(lineage)).toMatch(/^[0-9a-f]{64}$/);
      expect(lineage.sourceClaims[0]?.LedgerSourceClaim).toMatchObject({
        targetAmountAtClaim: 42.5,
      });
      expect(
        await previewFinancialSpending(ctx.db, {
          transactionId: transaction.output.id,
          advice,
        }),
      ).toMatchObject({
        status: "review_required",
        reason: "The booking lineage changed; reconcile the existing Expenses.",
      });
      const result = await getDb(ctx.db).execute<{
        cost: number;
        costType: string;
        category: string;
        owner: string;
      }>(sql`SELECT (e."costMinor"::float8 / 100) AS cost, e."costType", c.shortcode AS category, lp.shortcode AS owner
      FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId"
      JOIN "SpendingCategory" c ON c.id = e."spendingCategoryId"
      JOIN "LedgerParty" lp ON lp.id = p."purchaserOverrideId"
      WHERE e."deletedAt" IS NULL`);
      expect(
        result.rows.map((row) => ({ ...row, cost: Number(row.cost) })),
      ).toEqual([
        {
          cost: 42.5,
          costType: costType ?? "materials",
          category: category.id,
          owner: owner.output.id,
        },
      ]);
    },
  );
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
        await updatePurchaseEventWhere(
          ctx.db,
          "purchase",
          { vendorId: other.entityId },
          eq(purchase.shortcode, saved.purchaseIds[0]!),
        );
      }
      await expect(
        commitFinancialSpending(ctx.db, plan, ctx.actor),
      ).rejects.toThrow(/identity|evidence changed/);
      expect(
        await getDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense),
      ).toEqual([{ cost: 42.5 }]);
    },
  );
  it("holds older and undated partly paid same-vendor spending until the member excludes it", async () => {
    const { account, transaction, vendor, advice } = await fixture();
    const receipt = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-03-01",
      statedTotal: 40,
    });
    const line = await createRepoIdentity(ctx, "expense", {
      purchaseId: receipt.output.id,
      name: "Synthetic receipt",
      cost: 40,
      trade: "other",
    });
    // A first installment leaves the older receipt partly paid.
    await createRepoIdentity(ctx, "financialTransaction", {
      accountId: account.output.id,
      kind: "purchase",
      status: "posted",
      amount: 10,
      transactionDate: "2026-03-01",
      postedDate: "2026-03-01",
      allocations: [{ purchaseId: receipt.output.id, amount: 10 }],
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
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
    ).toEqual([{ cost: 40 }]);
    expect(
      await getDb(ctx.db)
        .select({ name: purchase.displayLabel })
        .from(purchase),
    ).toHaveLength(1);
    await updatePurchaseEventWhere(
      ctx.db,
      "purchase",
      { date: null },
      eq(purchase.shortcode, receipt.output.id),
    );
    await updatePurchaseEventWhere(
      ctx.db,
      "expense",
      { cost: null },
      eq(expense.shortcode, line.output.id),
    );
    expect(
      await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      }),
    ).toMatchObject({ status: "review_required" });
    const reviewed = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
      rejectedPurchaseIds: [receipt.output.id],
    });
    expect(reviewed).toMatchObject({
      status: "ready",
      effect: "create_aggregate",
    });
    await commitFinancialSpending(ctx.db, reviewed, ctx.actor);
    expect(
      (
        await getDb(ctx.db)
          .select({ cost: expenseCostDollarsSql() })
          .from(expense)
      )
        .map((row) => row.cost)
        .sort(),
    ).toEqual([42.5, null]);
  });
  // Older same-vendor spending blocks only while charge-side capacity can be open.
  it.each([
    [
      "never paid",
      "ready",
      { posted: 0, expected: 0, returned: 0, reimbursed: false },
    ],
    [
      "an expected installment",
      "review_required",
      { posted: 10, expected: 30, returned: 0, reimbursed: false },
    ],
    [
      "returned principal",
      "review_required",
      { posted: 30, expected: 0, returned: 10, reimbursed: false },
    ],
    [
      "a reimbursement-linked payment",
      "review_required",
      { posted: 40, expected: 0, returned: 0, reimbursed: true },
    ],
  ] as const)("older spending %s previews %s", async (_case, status, setup) => {
    const { account, transaction, vendor, advice } = await fixture();
    const receipt = await createRepoIdentity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-03-01",
      statedTotal: 40,
    });
    for (const [name, cost] of [
      ["Synthetic receipt", 40],
      ["Synthetic return", -setup.returned],
    ] as const)
      if (cost)
        await createRepoIdentity(ctx, "expense", {
          purchaseId: receipt.output.id,
          name,
          cost,
          trade: "other",
        });
    for (const [state, amount] of [
      ["posted", setup.posted],
      ["expected", setup.expected],
    ] as const)
      if (amount) {
        const payment = await createRepoIdentity(ctx, "financialTransaction", {
          accountId: account.output.id,
          kind: "purchase",
          status: state,
          amount,
          transactionDate: "2026-03-01",
          postedDate: state === "posted" ? "2026-03-01" : null,
          allocations: [{ purchaseId: receipt.output.id, amount }],
        });
        if (!setup.reimbursed) continue;
        const reimbursement = await createRepoIdentity(ctx, "expense", {
          purchaseId: receipt.output.id,
          name: "Synthetic reimbursement",
          cost: amount,
          trade: "other",
        });
        await updatePurchaseEventWhere(
          ctx.db,
          "expense",
          {
            economicRole: "reimbursement",
            bookingTransactionCode: payment.output.id,
          },
          eq(expense.shortcode, reimbursement.output.id),
        );
      }
    expect(
      await previewFinancialSpending(ctx.db, {
        transactionId: transaction.output.id,
        advice,
      }),
    ).toMatchObject({ status });
  });
  // A receipt without payment evidence settles only when the match is unique
  // on both the Purchase and the charge side.
  it.each([
    ["a unique exact receipt", "ready", { receipts: 1, charges: 0 }],
    ["two exact receipts", "review_required", { receipts: 2, charges: 0 }],
    ["a competing charge", "review_required", { receipts: 1, charges: 1 }],
  ] as const)("%s previews %s", async (_case, status, setup) => {
    const { account, transaction, vendor, advice } = await fixture();
    const receipts = [];
    for (let index = 0; index < setup.receipts; index++) {
      const receipt = await createRepoIdentity(ctx, "purchase", {
        vendorId: vendor.output.id,
        date: "2026-05-03",
        statedTotal: 42.5,
      });
      await createRepoIdentity(ctx, "expense", {
        purchaseId: receipt.output.id,
        name: "Synthetic emailed receipt",
        cost: 42.5,
        trade: "other",
      });
      receipts.push(receipt.output.id);
    }
    if (setup.charges)
      await createRepoIdentity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        status: "posted",
        amount: 42.5,
        transactionDate: "2026-05-02",
        postedDate: "2026-05-02",
        merchant: "Synthetic Orchard",
        sourceRefs: [
          { source: "synthetic-bank", externalId: "synthetic-competing" },
        ],
      });
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice,
    });
    expect(plan).toMatchObject({ status });
    if (plan.status !== "ready") return;
    expect(plan).toMatchObject({
      effect: "link_existing",
      purchaseId: receipts[0],
    });
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      (
        await getDb(ctx.db)
          .select({ amount: financialTransactionAllocation.amountMinor })
          .from(financialTransactionAllocation)
      ).map((row) => Number(row.amount)),
    ).toEqual([4250]);
  });
  // The set-based writers must write what the same charges write one at a time.
  it("creates and books a batch exactly as it does one charge at a time", async () => {
    const { account, advice } = await fixture();
    // Distinct Vendors keep each plan's snapshot independent of the other's booking;
    // dates further apart than the candidate window make the page span both.
    await createRepoIdentity(ctx, "vendor", { name: "Synthetic Bakery" });
    const merchants = ["Synthetic Orchard", "Synthetic Bakery"];
    const days = ["04", "26"];
    const inputs = (prefix: string, month: string) =>
      [19, 23].map((amount, index) =>
        buildEntity("financialTransaction", {
          accountId: account.output.id,
          kind: "purchase",
          status: "posted",
          amount,
          transactionDate: `2026-${month}-${days[index]}`,
          postedDate: `2026-${month}-${days[index]}`,
          merchant: merchants[index],
          rawDescription: null,
          sourceCategory: null,
          notes: null,
          sourceRefs: [
            { source: "synthetic-bank", externalId: `${prefix}-${index}` },
          ],
        }),
      );
    const commitPlans = async (
      ids: FinancialTransactionId[],
      batch: boolean,
    ) => {
      const rows = await getDb(ctx.db)
        .select({ id: transactionTable.id, code: transactionTable.shortcode })
        .from(transactionTable)
        .where(inArray(transactionTable.id, ids));
      const plans = await Promise.all(
        ids.map((id, index) =>
          previewFinancialSpending(ctx.db, {
            transactionId: parseShortcodeFor(
              "financialTransaction",
              rows.find((row) => row.id === id)!.code,
            ),
            advice: financialSpendingAdvice.parse({
              ...advice,
              vendorName: merchants[index],
            }),
          }),
        ),
      );
      expect(plans.map((plan) => plan.status)).toEqual(["ready", "ready"]);
      if (batch)
        await commitFinancialSpendings(
          ctx.db,
          plans.map((plan) => ({ plan })),
          ctx.actor,
        );
      else
        for (const plan of plans)
          await commitFinancialSpending(ctx.db, plan, ctx.actor);
    };
    const single: FinancialTransactionId[] = [];
    for (const input of inputs("single", "02"))
      single.push(
        (
          await createFinancialTransaction.read(
            ["id"],
            ctx.db,
            input,
            ctx.actor,
          )
        ).entityId,
      );
    await commitPlans(single, false);
    await commitPlans(
      await withTransaction(ctx.db, (tx) =>
        createFinancialTransactions(tx, inputs("batch", "10"), ctx.actor),
      ),
      true,
    );

    const written = async (prefix: string) => {
      const db = getDb(ctx.db);
      const aliases = await db
        .select()
        .from(financialEvidenceAlias)
        .where(like(financialEvidenceAlias.value, `${prefix}-%`));
      const ids = aliases.map((alias) => alias.historicalTransactionId!);
      const transactions = await db
        .select()
        .from(transactionTable)
        .where(inArray(transactionTable.id, ids));
      const allocations = await db
        .select()
        .from(financialTransactionAllocation)
        .where(inArray(financialTransactionAllocation.transactionId, ids));
      const expenses = await db
        .select(dollarExpenseColumns())
        .from(expense)
        .where(
          inArray(
            expense.bookingTransactionCode,
            transactions.map((row) => row.shortcode),
          ),
        );
      const purchases = await db
        .select()
        .from(purchase)
        .where(
          inArray(
            purchase.id,
            allocations.map((row) => row.purchaseId),
          ),
        );
      const audits = await db
        .select({ kind: auditLog.entityKind, action: auditLog.action })
        .from(auditLog)
        .where(
          inArray(auditLog.entityId, [
            ...ids,
            ...allocations.map((row) => row.id),
            ...expenses.map((row) => row.id),
            ...purchases.map((row) => row.id),
          ]),
        );
      const sorted = (rows: unknown[][]) =>
        rows.map((row) => JSON.stringify(row)).sort();
      return {
        transactions: sorted(
          transactions.map((row) => [
            String(row.amount),
            row.kind,
            row.status,
            row.merchant,
            row.bookingDecisionFingerprint !== null,
            row.bookingExpenseFingerprint !== null,
          ]),
        ),
        aliases: sorted(
          aliases.map((row) => [
            row.value.slice(prefix.length),
            row.kind,
            row.provenance,
          ]),
        ),
        allocations: sorted(
          allocations.map((row) => [
            String(row.amountMinor),
            row.confirmsMerchant,
          ]),
        ),
        expenses: sorted(
          expenses.map((row) => [
            row.cost,
            row.name,
            row.economicRole,
            row.costType,
            row.lineKind,
            row.lineBasis,
            row.spendingCategoryId,
          ]),
        ),
        purchases: sorted(
          purchases.map((row) => [
            row.vendorId,
            row.displayLabel,
            row.purchaserOverrideId,
            row.spendingCategoryId,
          ]),
        ),
        audits: sorted(audits.map((row) => [row.kind, row.action])),
      };
    };
    const expected = await written("single");
    expect(expected.transactions).toEqual([
      JSON.stringify(["1900", "purchase", "posted", merchants[0], true, true]),
      JSON.stringify(["2300", "purchase", "posted", merchants[1], true, true]),
    ]);
    expect(expected.expenses).toHaveLength(2);
    expect(await written("batch")).toEqual(expected);
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
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
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
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
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
    await updateSeedBankTransaction(ctx.db, transaction.output.id, {
      status: "pending",
      postedDate: null,
    });
    const replay = await previewFinancialSpending(ctx.db, request);
    expect(replay.status).toBe("already_booked");
    await commitFinancialSpending(ctx.db, replay, ctx.actor);
    expect(
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
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
    expect(
      await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
    ).toEqual([]);
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
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
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
        .select({ cost: expenseCostDollarsSql(), costType: expense.costType })
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
    expect(
      await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
    ).toEqual([]);
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
    expect(
      await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
    ).toEqual([]);
    const fresh = await previewFinancialSpending(ctx.db, {
      transactionId: transaction.output.id,
      advice: proposed,
    });
    await commitFinancialSpending(ctx.db, fresh, ctx.actor);
    expect(
      await getDb(ctx.db).query.vendor.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(
              table,
              eq(vendorTable.shortcode, competing.output.id),
            ),
        },
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
        where: {
          RAW: (table: PgTable) =>
            relationalSql(table, eq(vendorTable.name, "Synthetic River")),
        },
      }),
    ).toBeUndefined();
    expect(
      await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
    ).toEqual([]);
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      await getDb(ctx.db).query.vendor.findFirst({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(table, eq(vendorTable.name, "Synthetic River")),
        },
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
    await updatePurchaseEventWhere(
      ctx.db,
      "expense",
      { cost: 4250n, lineKind: "unclassified" },
      eq(expense.shortcode, line.output.id),
    );
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
      .set({ ledgerPartyId: null })
      .where(eq(financialAccount.shortcode, account.output.id));
    await expect(
      commitFinancialSpending(ctx.db, plan, ctx.actor),
    ).rejects.toThrow(/changed|review/i);
    expect(
      await getDb(ctx.db).select(dollarExpenseColumns()).from(expense),
    ).toEqual([]);
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
    // Full capacity is not a different event: a settlement that is not another
    // proven occurrence of this charge's source may be this same charge.
    expect(
      await previewFinancialSpending(ctx.db, {
        transactionId: next.output.id,
        advice,
      }),
    ).toMatchObject({ status: "review_required" });
    const plan = await previewFinancialSpending(ctx.db, {
      transactionId: next.output.id,
      advice,
      purchaseId: saved.purchaseIds[0],
    });
    expect(plan.status).toBe("review_required");
    expect(
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
    ).toEqual([{ cost: 42.5 }]);
    // A settling charge of another amount is a different bank event.
    await updateFinancialTransaction(
      ctx.db,
      next.output.id,
      { amount: 17.25 },
      ctx.actor,
    );
    expect(
      await previewFinancialSpending(ctx.db, {
        transactionId: next.output.id,
        advice,
      }),
    ).toMatchObject({ status: "ready", effect: "create_aggregate" });
    await updateFinancialTransaction(
      ctx.db,
      next.output.id,
      {
        amount: 42.5,
        transactionDate: "2026-07-04",
        postedDate: "2026-07-04",
      },
      ctx.actor,
    );
    const independent = await previewFinancialSpending(ctx.db, {
      transactionId: next.output.id,
      advice,
    });
    expect(independent).toMatchObject({
      status: "ready",
      effect: "create_aggregate",
    });
    await commitFinancialSpending(ctx.db, independent, ctx.actor);
    expect(
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
    ).toEqual([{ cost: 42.5 }, { cost: 42.5 }]);
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
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
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
      .select({
        cost: expenseCostDollarsSql(),
        category: expense.spendingCategoryId,
      })
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
    // An original outside the refund window still needs the member's choice.
    const request = { transactionId: transaction.output.id, advice };
    expect((await previewFinancialSpending(ctx.db, request)).status).toBe(
      "review_required",
    );
    await updatePurchaseEventWhere(
      ctx.db,
      "purchase",
      { date: "2026-04-28" },
      eq(purchase.shortcode, original.output.id),
    );
    // One recent same-Vendor original whose open returned line is exactly the
    // refund identifies it.
    expect(await previewFinancialSpending(ctx.db, request)).toMatchObject({
      status: "ready",
      effect: "link_existing",
      purchaseId: original.output.id,
    });
    const plan = await previewFinancialSpending(ctx.db, {
      ...request,
      purchaseId: original.output.id,
    });
    expect(plan.status).toBe("ready");
    await commitFinancialSpending(ctx.db, plan, ctx.actor);
    expect(
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense)
        .orderBy(expense.cost),
    ).toEqual([{ cost: -12 }, { cost: 100 }]);
    expect(
      await getDb(ctx.db)
        .select({
          amount:
            sql<number>`${financialTransactionAllocation.amountMinor}::numeric / 100`.mapWith(
              Number,
            ),
        })
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
      await getDb(ctx.db)
        .select({ cost: expenseCostDollarsSql() })
        .from(expense),
    ).toEqual([{ cost: -9 }]);
  });
});
