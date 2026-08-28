import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { expenseAttribution, ledgerParty } from "~/server/db/schema";
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
