import type { FinancialTransactionOut } from "@cubby/schemas/financial-transaction";
import {
  financialTransactionShortcode,
  purchaseShortcode,
} from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { composeSettlementReview } from "./purchase-settlement-review";

const ftx = (suffix: string) =>
  financialTransactionShortcode.parse(`FTX-${suffix}`);
const purchase = {
  id: purchaseShortcode.parse("PUR-2345"),
  date: "2026-03-02",
  statedTotal: 42.5,
};
const candidate = (
  suffix: string,
  overrides: Partial<FinancialTransactionOut> = {},
  rank: {
    days?: number;
    exactAmount?: boolean;
    merchantMatches?: boolean;
  } = {},
) => ({
  transaction: fromPartial<FinancialTransactionOut>({
    id: ftx(suffix),
    kind: "purchase",
    amount: 42.5,
    merchant: "Example Hardware",
    displayName: "Example Hardware",
    rawDescription: null,
    postedDate: "2026-03-04",
    transactionDate: "2026-03-03",
    ...overrides,
  }),
  days: 2,
  exactAmount: true,
  merchantMatches: true,
  ...rank,
});

// "Suggest a match" only reorders statement entries the deterministic ranking
// already tied. Which entries are tied, what each says and the rows an
// allocation starts from are server facts: web and native render them, and
// neither re-derives a rank or a split.
describe("composeSettlementReview", () => {
  it("words each candidate and proposes its allocation rows", () => {
    const review = composeSettlementReview(purchase, [
      candidate(
        "4K7M",
        { rawDescription: "EXAMPLE HDWE #12", amount: 91 },
        { exactAmount: false },
      ),
    ]);
    expect(review.message).toBeNull();
    expect(review.candidates[0]).toMatchObject({
      title: "Example Hardware",
      lines: [
        "Charge",
        "Statement: EXAMPLE HDWE #12",
        "2026-03-04 · 2 days apart · vendor name matches",
      ],
      proposedAllocations: [
        { purchaseId: "PUR-2345", amount: "42.50" },
        { purchaseId: "", amount: "48.50" },
      ],
    });
  });

  it("names a refund and a single day", () => {
    const review = composeSettlementReview(purchase, [
      candidate(
        "4K7M",
        { kind: "refund", amount: -10, postedDate: null },
        { days: 1, merchantMatches: false },
      ),
    ]);
    expect(review.candidates[0]?.lines).toEqual([
      "Refund",
      "2026-03-03 · 1 day apart · vendor differs",
    ]);
    expect(review.candidates[0]?.proposedAllocations).toEqual([
      { purchaseId: "PUR-2345", amount: "-10.00" },
    ]);
  });

  it("offers a suggestion only while two or more candidates tie at the top rank", () => {
    const tied = composeSettlementReview(purchase, [
      candidate("4K7M"),
      candidate("5N8P"),
      candidate("6Q9R", {}, { exactAmount: false }),
    ]);
    expect(tied.tiedTransactionIds).toEqual([ftx("4K7M"), ftx("5N8P")]);
    expect(tied.suggestHint).toBe(
      "2 charges rank equally. Jev can suggest which fits best; you still choose and allocate.",
    );

    const single = composeSettlementReview(purchase, [
      candidate("4K7M"),
      candidate("6Q9R", {}, { exactAmount: false }),
    ]);
    expect(single.tiedTransactionIds).toEqual([]);
    expect(single.suggestHint).toBeNull();
  });

  it("says why there is nothing to review", () => {
    expect(
      composeSettlementReview({ ...purchase, date: null }, []).message,
    ).toBe("Add the order date to see likely statement activity.");
    expect(composeSettlementReview(purchase, []).message).toBe(
      "No unallocated vendor or exact amount match within 45 days. You can still add a transaction manually.",
    );
  });
});
