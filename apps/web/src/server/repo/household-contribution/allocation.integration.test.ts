import type {
  ExpenseId,
  FinancialAccountId,
  LedgerPartyId,
} from "@cubby/schemas/identifiers";
import type { LedgerPartyKind } from "@cubby/schemas/ledger-party";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  expenseAttribution,
  financialAccount,
  financialTransactionAllocation,
  ledgerParty,
} from "~/server/db/schema";
import { insertAndReturn, unwrapDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { loadExpenseAllocations } from "./allocation";

describe("loadExpenseAllocations SQL arithmetic", () => {
  const ctx = withTestDb("mcp");

  it.each([
    ["large cost", 50_000_000.01, 5_000_000_001n],
    ["large refund", -50_000_000.01, -5_000_000_001n],
  ])(
    "allocates a %s at maximum weights without bigint multiplication overflow",
    async (_label, cost, expectedCents) => {
      const people = await Promise.all(
        [
          { name: "First beneficiary", shortcode: "LPY-AL01" },
          { name: "Second beneficiary", shortcode: "LPY-AL02" },
        ].map((row) =>
          insertAndReturn(ctx.db, ledgerParty, {
            ...row,
            kind: "guest",
          }),
        ),
      );
      const [first, second] = people;
      if (!first || !second)
        throw new Error("Expected two beneficiary fixtures");
      const row = await insertWithShortcode(ctx.db, "expense", {
        name: "Large weighted allocation fixture",
        cost,
        date: "2026-08-20",
        costType: "materials",
        trade: "other",
        future: false,
      });
      await unwrapDb(ctx.db)
        .insert(expenseAttribution)
        .values([
          {
            expenseId: row.id,
            role: "beneficiary",
            ledgerPartyId: first.id,
            weight: 2_147_483_647,
          },
          {
            expenseId: row.id,
            role: "beneficiary",
            ledgerPartyId: second.id,
            weight: 2_147_483_646,
          },
        ]);

      const allocations = await loadExpenseAllocations(ctx.db, {
        asOf: "2026-08-20",
      });
      const beneficiaryCents = allocations
        .filter(
          (allocation) =>
            allocation.expenseId === row.id &&
            allocation.role === "beneficiary",
        )
        .map((allocation) => allocation.cents);

      expect(beneficiaryCents).toHaveLength(2);
      expect(beneficiaryCents.reduce((total, cents) => total + cents, 0n)).toBe(
        expectedCents,
      );
      for (const cents of beneficiaryCents) {
        expect(cents > 0n).toBe(expectedCents > 0n);
      }
    },
  );

  it("uses LedgerParty shortcode, rather than UUID, for a tied leftover cent", async () => {
    const [first, second] = await Promise.all([
      insertAndReturn(ctx.db, ledgerParty, {
        name: "Later shortcode",
        shortcode: "LPY-ZZZZ",
        kind: "member",
      }),
      insertAndReturn(ctx.db, ledgerParty, {
        name: "Earlier shortcode",
        shortcode: "LPY-AAAA",
        kind: "member",
      }),
    ]);
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: "Shortcode tie fixture",
      cost: 0.01,
      date: "2026-08-20",
      costType: "materials",
      trade: "other",
      future: false,
    });
    await unwrapDb(ctx.db)
      .insert(expenseAttribution)
      .values([
        {
          expenseId: expense.id,
          role: "beneficiary",
          ledgerPartyId: first.id,
          weight: 1,
        },
        {
          expenseId: expense.id,
          role: "beneficiary",
          ledgerPartyId: second.id,
          weight: 1,
        },
      ]);

    const rows = await loadExpenseAllocations(ctx.db, { asOf: "2026-08-20" });
    const allocations = rows.filter(
      (row) => row.expenseId === expense.id && row.role === "beneficiary",
    );

    expect(allocations).toEqual([
      expect.objectContaining({ allocationKey: "LPY-AAAA", cents: 1n }),
      expect.objectContaining({ allocationKey: "LPY-ZZZZ", cents: 0n }),
    ]);
  });
});

describe("loadExpenseAllocations derived funders", () => {
  const ctx = withTestDb("mcp");

  /** A purchase paid by `splits`, and one expense line booked against it. */
  const payFor = async (
    cost: number,
    splits: { accountId: FinancialAccountId; amount: number; kind?: string }[],
  ) => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: `Vendor ${splits.length}-${cost}`,
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-10",
    });
    const expense = await insertWithShortcode(ctx.db, "expense", {
      name: `Derived funder fixture ${cost}`,
      cost,
      date: "2026-08-10",
      costType: "materials",
      trade: "other",
      future: false,
      purchaseId: purchase.id,
    });
    for (const split of splits) {
      const txn = await insertWithShortcode(ctx.db, "financialTransaction", {
        accountId: split.accountId,
        kind: split.kind ?? "purchase",
        status: "posted",
        postedDate: "2026-08-10",
        amount: split.amount,
      });
      await unwrapDb(ctx.db).insert(financialTransactionAllocation).values({
        transactionId: txn.id,
        purchaseId: purchase.id,
        amount: split.amount,
      });
    }
    return expense;
  };

  const mkAccount = async (
    shortcode: string,
    name: string,
    ledgerPartyId: LedgerPartyId | null,
  ) =>
    insertAndReturn(ctx.db, financialAccount, {
      name,
      shortcode,
      identity: { kind: "cash" },
      ledgerPartyId,
    });

  const mkParty = async (
    name: string,
    shortcode: string,
    kind: LedgerPartyKind,
  ) => insertAndReturn(ctx.db, ledgerParty, { name, shortcode, kind });

  const fundersOf = async (expenseId: ExpenseId) =>
    (await loadExpenseAllocations(ctx.db, { asOf: "2026-08-10" })).filter(
      (row) => row.expenseId === expenseId && row.role === "funder",
    );

  it("derives the funder from the paying account's owner", async () => {
    const party = await mkParty("Payer", "LPY-PAY1", "member");
    const account = await mkAccount("FAC-CRDA", "Card A", party.id);
    const expense = await payFor(100, [{ accountId: account.id, amount: 100 }]);

    expect(await fundersOf(expense.id)).toEqual([
      expect.objectContaining({
        allocationKey: "LPY-PAY1",
        basis: "derived_from_payment",
        cents: 10_000n,
      }),
    ]);
  });

  it("splits proportionally between two owning parties", async () => {
    const [one, two] = await Promise.all([
      mkParty("Split one", "LPY-SPA1", "member"),
      mkParty("Split two", "LPY-SPB2", "member"),
    ]);
    const [a, b] = await Promise.all([
      mkAccount("FAC-SPLA", "Split A", one.id),
      mkAccount("FAC-SPLB", "Split B", two.id),
    ]);
    const expense = await payFor(100, [
      { accountId: a.id, amount: 75 },
      { accountId: b.id, amount: 25 },
    ]);

    const funders = await fundersOf(expense.id);
    expect(funders).toEqual([
      expect.objectContaining({ allocationKey: "LPY-SPA1", cents: 7_500n }),
      expect.objectContaining({ allocationKey: "LPY-SPB2", cents: 2_500n }),
    ]);
    expect(funders.reduce((total, row) => total + row.cents, 0n)).toBe(10_000n);
  });

  it("flags a paying account with no owner rather than inventing one", async () => {
    const account = await mkAccount("FAC-ORPH", "Orphan", null);
    const expense = await payFor(50, [{ accountId: account.id, amount: 50 }]);

    expect(await fundersOf(expense.id)).toEqual([
      expect.objectContaining({
        ledgerPartyId: null,
        allocationKey: "~unowned-account",
        basis: "unowned_account",
        cents: 5_000n,
      }),
    ]);
  });

  it("still attributes a fully refunded order to the party that paid it", async () => {
    const party = await mkParty("Refunded", "LPY-RFND", "member");
    const account = await mkAccount("FAC-RFCD", "Refund card", party.id);
    const expense = await payFor(80, [
      { accountId: account.id, amount: 80 },
      { accountId: account.id, amount: -80, kind: "refund" },
    ]);

    // Weighting by GROSS outlay, not net. Under net weighting this order summed
    // to zero, the party dropped out, and every one of its expenses reported
    // missing_funders — 155 across the ledger. The money still nets to nothing,
    // because the refund is its own negative-cost Expense receiving a negative
    // share; subtracting it from the weight as well would charge it twice.
    expect(await fundersOf(expense.id)).toEqual([
      expect.objectContaining({
        allocationKey: "LPY-RFND",
        basis: "derived_from_payment",
        cents: 8_000n,
      }),
    ]);
  });

  it("lets an explicit funder attribution override the payment chain", async () => {
    const [payer, chosen] = await Promise.all([
      mkParty("Chain payer", "LPY-CHN1", "member"),
      mkParty("Explicit", "LPY-EXPL", "member"),
    ]);
    const account = await mkAccount("FAC-CHNC", "Chain card", payer.id);
    const expense = await payFor(40, [{ accountId: account.id, amount: 40 }]);
    await unwrapDb(ctx.db).insert(expenseAttribution).values({
      expenseId: expense.id,
      role: "funder",
      ledgerPartyId: chosen.id,
      weight: 1,
    });

    // Exactly one row: the derived arm must not fire alongside the explicit
    // one, which would inflate total_weight and halve the split.
    expect(await fundersOf(expense.id)).toEqual([
      expect.objectContaining({
        allocationKey: "LPY-EXPL",
        basis: "recorded",
        cents: 4_000n,
      }),
    ]);
  });

  it("splits each expense of a shared purchase against its own cost", async () => {
    const party = await mkParty("Shared", "LPY-SHRD", "member");
    const account = await mkAccount("FAC-SHRC", "Shared card", party.id);
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Shared vendor",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-08-10",
    });
    const txn = await insertWithShortcode(ctx.db, "financialTransaction", {
      accountId: account.id,
      kind: "purchase",
      status: "posted",
      postedDate: "2026-08-10",
      amount: 30,
    });
    await unwrapDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: txn.id,
      purchaseId: purchase.id,
      amount: 30,
    });
    const lines = await Promise.all(
      [10, 20].map((cost) =>
        insertWithShortcode(ctx.db, "expense", {
          name: `Shared line ${cost}`,
          cost,
          date: "2026-08-10",
          costType: "materials",
          trade: "other",
          future: false,
          purchaseId: purchase.id,
        }),
      ),
    );

    // Each line splits its OWN cost by the payment ratio — the purchase total
    // is never redistributed across lines.
    for (const [index, expected] of [1_000n, 2_000n].entries()) {
      const line = lines[index];
      if (!line) throw new Error("Expected two shared lines");
      expect(await fundersOf(line.id)).toEqual([
        expect.objectContaining({ allocationKey: "LPY-SHRD", cents: expected }),
      ]);
    }
  });
});

describe("loadExpenseAllocations assumed-household beneficiaries", () => {
  const ctx = withTestDb("mcp");

  const beneficiariesOf = async (expenseId: ExpenseId) =>
    (await loadExpenseAllocations(ctx.db, { asOf: "2026-08-10" })).filter(
      (row) => row.expenseId === expenseId && row.role === "beneficiary",
    );

  const mkExpense = (name: string) =>
    insertWithShortcode(ctx.db, "expense", {
      name,
      cost: 25,
      date: "2026-08-10",
      costType: "materials",
      trade: "other",
      future: false,
    });

  it("defaults to the household party, and an explicit row still wins", async () => {
    const household = await insertAndReturn(ctx.db, ledgerParty, {
      name: "The household",
      shortcode: "LPY-HHLD",
      kind: "household",
    });
    const member = await insertAndReturn(ctx.db, ledgerParty, {
      name: "A member",
      shortcode: "LPY-MEMB",
      kind: "member",
    });
    const assumed = await mkExpense("Assumed fixture");
    const explicit = await mkExpense("Explicit fixture");
    await unwrapDb(ctx.db).insert(expenseAttribution).values({
      expenseId: explicit.id,
      role: "beneficiary",
      ledgerPartyId: member.id,
      weight: 1,
    });

    expect(await beneficiariesOf(assumed.id)).toEqual([
      expect.objectContaining({
        ledgerPartyId: household.id,
        allocationKey: "LPY-HHLD",
        basis: "assumed_household",
        cents: 2_500n,
      }),
    ]);
    expect(await beneficiariesOf(explicit.id)).toEqual([
      expect.objectContaining({ allocationKey: "LPY-MEMB", basis: "recorded" }),
    ]);
  });
});
