import { describe, expect, it } from "vitest";

import { locationIdsHoldingProducts } from "./worklist-locations";

describe("locationIdsHoldingProducts", () => {
  it("collects each stocked location once across products", () => {
    const ids = locationIdsHoldingProducts([
      {
        inventoryEntry: [
          { placement: "stock", location: { id: "LOC-A" } },
          { placement: "stock", location: { id: "LOC-B" } },
        ],
      },
      { inventoryEntry: [{ placement: "stock", location: { id: "LOC-A" } }] },
    ]);
    expect([...ids].sort()).toEqual(["LOC-A", "LOC-B"]);
  });

  // The recount snapshot is stock-only, so an installed fixture is not a bin to
  // count and would queue a stop with nothing to confirm.
  it("ignores installed placement and products with no entries", () => {
    const ids = locationIdsHoldingProducts([
      {
        inventoryEntry: [{ placement: "installed", location: { id: "LOC-C" } }],
      },
      { inventoryEntry: [] },
    ]);
    expect(ids.size).toBe(0);
  });
});
