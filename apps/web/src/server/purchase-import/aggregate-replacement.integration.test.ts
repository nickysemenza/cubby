import { testEntityId } from "@cubby/schemas/testing";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { withTransaction } from "~/server/repo/database-helpers";

import { redistributeReplacementAttributions } from "./aggregate-replacement";

// Independent per-line rounding can silently move a cent between people.
// Mixed signed receipt rows must preserve both every line and every party total.
describe("reviewed receipt attribution transport", () => {
  const ctx = withTestDb();
  it("preserves each party's exact cents across positive lines and a discount", async () => {
    const parties = [
      testEntityId("ledgerParty", "receipt-first"),
      testEntityId("ledgerParty", "receipt-second"),
    ];
    const result = await withTransaction(ctx.db, (tx) =>
      redistributeReplacementAttributions(
        tx,
        [
          {
            role: "beneficiary",
            ledgerPartyId: parties[0]!,
            allocationKey: "LPY-AAAA",
            cents: 1n,
          },
          {
            role: "beneficiary",
            ledgerPartyId: parties[1]!,
            allocationKey: "LPY-BBBB",
            cents: 1n,
          },
        ],
        [
          { title: "First item", amount: 0.01, lineKind: "principal" },
          { title: "Second item", amount: 0.02, lineKind: "principal" },
          { title: "Discount", amount: -0.01, lineKind: "discount" },
        ],
      ),
    );
    for (const partyId of parties)
      expect(
        result
          .filter((row) => row.partyId === partyId)
          .reduce((sum, row) => sum + Math.round(row.amount * 100), 0),
      ).toBe(1);
    for (const [index, amount] of [1, 2, -1].entries())
      expect(
        result
          .filter((row) => row.lineIndex === index)
          .reduce((sum, row) => sum + Math.round(row.amount * 100), 0),
      ).toBe(amount);
  });
});
