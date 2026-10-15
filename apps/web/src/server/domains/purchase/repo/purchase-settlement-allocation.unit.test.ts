import { describe, expect, it } from "vitest";

import {
  checkSettlementAllocationDraft,
  proposeSettlementAllocations,
} from "./purchase-settlement-allocation";

// Settlement evidence only moves how a charge is attributed across Purchases;
// it never creates spend. These cases guard the one money rule behind the
// allocation form on every client: the allocations must add up to the
// statement amount to the cent, with its sign, one row per Purchase.
describe("proposeSettlementAllocations", () => {
  it("caps the first row at the stated total and leaves the rest for another Purchase", () => {
    expect(
      proposeSettlementAllocations(
        "PUR-2345",
        { amount: 91, kind: "purchase" },
        { statedTotal: 42.5 },
      ),
    ).toEqual([
      { purchaseId: "PUR-2345", amount: "42.50" },
      { purchaseId: "", amount: "48.50" },
    ]);
  });

  it("allocates the whole charge when it does not exceed the stated total", () => {
    expect(
      proposeSettlementAllocations(
        "PUR-2345",
        { amount: 40, kind: "purchase" },
        { statedTotal: 42.5 },
      ),
    ).toEqual([{ purchaseId: "PUR-2345", amount: "40.00" }]);
  });

  it("never splits a refund against the stated total", () => {
    expect(
      proposeSettlementAllocations(
        "PUR-2345",
        { amount: -91, kind: "refund" },
        { statedTotal: 42.5 },
      ),
    ).toEqual([{ purchaseId: "PUR-2345", amount: "-91.00" }]);
  });

  it("allocates everything when the order states no total", () => {
    expect(
      proposeSettlementAllocations(
        "PUR-2345",
        { amount: 12.34, kind: "purchase" },
        { statedTotal: null },
      ),
    ).toEqual([{ purchaseId: "PUR-2345", amount: "12.34" }]);
  });

  it("proposes rows that conserve the transaction amount to the cent", () => {
    const rows = proposeSettlementAllocations(
      "PUR-2345",
      { amount: 0.3, kind: "purchase" },
      { statedTotal: 0.1 },
    );
    const cents = rows.reduce(
      (sum, row) => sum + Math.round(Number(row.amount) * 100),
      0,
    );
    expect(cents).toBe(30);
  });
});

describe("checkSettlementAllocationDraft", () => {
  const rows = [
    { purchaseId: "PUR-2345", amount: "42.50" },
    { purchaseId: "PUR-3456", amount: "48.50" },
  ];

  it("accepts a complete split and returns typed allocations", () => {
    expect(checkSettlementAllocationDraft(rows, 91)).toEqual({
      allocations: [
        { purchaseId: "PUR-2345", amount: 42.5 },
        { purchaseId: "PUR-3456", amount: 48.5 },
      ],
      allocatedTotal: 91,
      remaining: 0,
      reason: null,
    });
  });

  it("refuses an unfilled remainder and reports what is left", () => {
    const result = checkSettlementAllocationDraft(
      [rows[0]!, { purchaseId: "", amount: "48.50" }],
      91,
    );
    expect(result.allocations).toBeNull();
    expect(result.reason).toMatch(/Purchase/);
  });

  it("refuses a total that is off by one cent, in either direction", () => {
    const short = checkSettlementAllocationDraft(
      [rows[0]!, { purchaseId: "PUR-3456", amount: "48.49" }],
      91,
    );
    expect(short.allocations).toBeNull();
    expect(short.remaining).toBe(0.01);
    const over = checkSettlementAllocationDraft(
      [rows[0]!, { purchaseId: "PUR-3456", amount: "48.51" }],
      91,
    );
    expect(over.allocations).toBeNull();
    expect(over.remaining).toBe(-0.01);
    expect(over.reason).toMatch(/\$91\.01/);
  });

  it("sums in cents, so binary-fraction amounts still conserve", () => {
    expect(
      checkSettlementAllocationDraft(
        [
          { purchaseId: "PUR-2345", amount: "0.10" },
          { purchaseId: "PUR-3456", amount: "0.20" },
        ],
        0.3,
      ).allocations,
    ).toEqual([
      { purchaseId: "PUR-2345", amount: 0.1 },
      { purchaseId: "PUR-3456", amount: 0.2 },
    ]);
  });

  it("refuses an amount with the opposite sign from the statement entry", () => {
    expect(
      checkSettlementAllocationDraft(
        [{ purchaseId: "PUR-2345", amount: "15.00" }],
        -15,
      ).allocations,
    ).toBeNull();
  });

  it("refuses a zero row, a fractional cent, a blank amount and a repeated Purchase", () => {
    for (const bad of [
      [{ purchaseId: "PUR-2345", amount: "0" }],
      [{ purchaseId: "PUR-2345", amount: "91.001" }],
      [{ purchaseId: "PUR-2345", amount: "  " }],
    ]) {
      expect(checkSettlementAllocationDraft(bad, 91).allocations).toBeNull();
    }
    const repeated = checkSettlementAllocationDraft(
      [
        { purchaseId: "PUR-2345", amount: "40.00" },
        { purchaseId: "PUR-2345", amount: "51.00" },
      ],
      91,
    );
    expect(repeated.allocations).toBeNull();
    expect(repeated.reason).toMatch(/PUR-2345/);
  });

  it("refuses an empty draft and a malformed Purchase code", () => {
    expect(checkSettlementAllocationDraft([], 91).allocations).toBeNull();
    const malformed = checkSettlementAllocationDraft(
      [{ purchaseId: "not-a-code", amount: "91.00" }],
      91,
    );
    expect(malformed.allocations).toBeNull();
    expect(malformed.reason).toMatch(/Purchase code/);
  });
});
