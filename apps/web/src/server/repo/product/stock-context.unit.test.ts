import { describe, expect, it } from "vitest";

import { productStockContext } from "./stock-context";

// A missing ledger must not imply disposal; incomplete or non-count inventory
// must not produce a precise missing-item claim. Policy never hides stock.
const ledger = {
  acquiredUnits: 0,
  exitedUnits: 0,
  expectedQuantity: 0,
  unknownAcquisitionLines: 0,
  unknownExitLines: 0,
  locationCount: 0,
};
describe("product stock context", () => {
  it("distinguishes an empty history from acquisitions balanced by exits", () => {
    expect(
      productStockContext({ quantityLedger: ledger, inventoryEntry: [] })
        .stockStatus,
    ).toBe("No inventory recorded");
    expect(
      productStockContext({
        quantityLedger: { ...ledger, acquiredUnits: 2, exitedUnits: 2 },
        inventoryEntry: [],
      }).stockStatus,
    ).toBe("Recorded balance: 0");
  });
  it("keeps unknown history ahead of a numeric zero", () => {
    expect(
      productStockContext({
        quantityLedger: { ...ledger, unknownAcquisitionLines: 1 },
        inventoryEntry: [],
      }).stockStatus,
    ).toBe("Quantity history incomplete");
  });
  it("reports only comparable partial gaps and retains the tracking policy", () => {
    const context = productStockContext({
      quantityLedger: { ...ledger, acquiredUnits: 3, expectedQuantity: 3 },
      inventoryEntry: [{ amount: { value: 2, unit: "each" } }],
      stockTracked: false,
    });
    expect(context.stockStatus).toBe("1 expected item unlocated");
    expect(
      context.stockStatusItems.some(
        (item) => item.title === "Stock not tracked",
      ),
    ).toBe(true);
    expect(
      productStockContext({
        quantityLedger: { ...ledger, acquiredUnits: 3, expectedQuantity: 3 },
        inventoryEntry: [{ amount: { value: 2, unit: "kg" } }],
      }).stockStatus,
    ).toBe("Inventory quantity not comparable");
  });
  it("includes installed locations without calling them unlocated", () => {
    const context = productStockContext({
      quantityLedger: {
        ...ledger,
        acquiredUnits: 1,
        expectedQuantity: 1,
        locationCount: 1,
      },
      inventoryEntry: [],
    });
    expect(context.stockStatus).toBe("Serves as a location");
  });
});
