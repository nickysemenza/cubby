import { describe, expect, it } from "vitest";

import { deriveProductQuantitySummary } from "./product-quantity-summary";

// One non-count unit must not turn kilograms into acquired product units, and
// incomplete history must not manufacture a precise reconciliation variance.
const ledger = {
  acquiredUnits: 3,
  exitedUnits: 0,
  expectedQuantity: 3,
  unknownAcquisitionLines: 0,
  unknownExitLines: 0,
  locationCount: 0,
};
describe("product quantity comparability", () => {
  it("rejects even a single non-count unit", () => {
    expect(
      deriveProductQuantitySummary(
        [{ amount: { value: 2, unit: "kg" } }],
        ledger,
      ),
    ).toMatchObject({ onHandUnits: null, quantityVariance: null });
  });
  it("keeps a counted shelf while suppressing variance against incomplete history", () => {
    expect(
      deriveProductQuantitySummary([{ amount: { value: 2, unit: "each" } }], {
        ...ledger,
        unknownAcquisitionLines: 1,
      }),
    ).toMatchObject({ onHandUnits: 2, quantityVariance: null });
  });
});
