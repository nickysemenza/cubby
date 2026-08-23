import {
  unsafeExpenseShortcode,
  unsafePersonShortcode,
} from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { loadExpenseAllocations } from "./allocation";
import { setExpenseAttribution } from "./mutations";

describe("loadExpenseAllocations SQL arithmetic", () => {
  const ctx = withTestDb("mcp");

  it.each([
    ["large cost", 50_000_000.01, 5_000_000_001n],
    ["large refund", -50_000_000.01, -5_000_000_001n],
  ])(
    "allocates a %s at maximum weights without bigint multiplication overflow",
    async (_label, cost, expectedCents) => {
      const people = await Promise.all(
        ["First beneficiary", "Second beneficiary"].map((name) =>
          insertWithShortcode(ctx.db, "person", { name, kind: "guest" }),
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
      await setExpenseAttribution(
        ctx.db,
        {
          type: "set_expense_attribution",
          expenseIds: [unsafeExpenseShortcode(row.shortcode)],
          beneficiaries: {
            people: [
              {
                personId: unsafePersonShortcode(first.shortcode),
                weight: 2_147_483_647,
              },
              {
                personId: unsafePersonShortcode(second.shortcode),
                weight: 2_147_483_646,
              },
            ],
          },
        },
        ctx.actor,
      );

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
});
