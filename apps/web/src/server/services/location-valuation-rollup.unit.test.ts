import { type LocationId, unsafeLocationId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import { rollupLocationValuations } from "./location-valuation-rollup";

const loc = (id: string, parentId?: string) => ({
  id: unsafeLocationId(id),
  parentId: parentId ? unsafeLocationId(parentId) : null,
});

const item = (
  locationId: string,
  valuation: number | null,
  productName = "Olive oil",
) => ({ locationId: unsafeLocationId(locationId), valuation, productName });

describe("rollupLocationValuations", () => {
  it("buckets direct items into priced / missing / misc", () => {
    const result = rollupLocationValuations(
      [
        item("a", 5),
        item("a", 3.5),
        item("a", null, "Flour"), // no price → missing
        item("a", null, "misc: batteries"), // no price + misc name → misc
        item("a", 0, "Salt"), // 0 → not priced; normal name → missing
      ],
      [loc("a")],
    );
    const a = result.get(unsafeLocationId("a"))!;
    expect(a.directValuation).toBe(8.5);
    expect(a.directItemCount).toBe(5);
    expect(a.direct).toEqual({
      priced: 2,
      missingPricing: 2,
      miscNoPrice: 1,
    });
    // No children → total equals direct.
    expect(a.totalValuation).toBe(8.5);
    expect(a.total).toEqual(a.direct);
  });

  it("rolls children up into ancestors (total = direct + descendants)", () => {
    // house → kitchen → pantry, plus house → garage
    const result = rollupLocationValuations(
      [
        item("kitchen", 50),
        item("pantry", 80),
        item("garage", 40),
        // house has no direct items
      ],
      [
        loc("house"),
        loc("kitchen", "house"),
        loc("pantry", "kitchen"),
        loc("garage", "house"),
      ],
    );
    const get = (id: string) => result.get(unsafeLocationId(id))!;

    expect(get("pantry").totalValuation).toBe(80);
    expect(get("kitchen").directValuation).toBe(50);
    expect(get("kitchen").totalValuation).toBe(130); // 50 + 80
    expect(get("house").directValuation).toBe(0);
    expect(get("house").totalValuation).toBe(170); // 0 + (130 + 40)
    expect(get("house").totalItemCount).toBe(3);
    expect(get("house").directItemCount).toBe(0);
  });

  it("rounds float dust to two decimals", () => {
    const result = rollupLocationValuations(
      [item("a", 0.1), item("a", 0.2)],
      [loc("a")],
    );
    expect(result.get(unsafeLocationId("a"))!.directValuation).toBe(0.3);
  });

  it("includes locations with no inventory as zeroed rollups", () => {
    const result = rollupLocationValuations([], [loc("empty")]);
    const e = result.get(unsafeLocationId("empty") as LocationId)!;
    expect(e.directValuation).toBe(0);
    expect(e.totalValuation).toBe(0);
    expect(e.total).toEqual({ priced: 0, missingPricing: 0, miscNoPrice: 0 });
  });
});
