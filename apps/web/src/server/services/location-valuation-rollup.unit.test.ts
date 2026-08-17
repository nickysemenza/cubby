import { type LocationId, unsafeLocationId } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";
import { rollupLocationValuations } from "./location-valuation-rollup";

const loc = (id: string, parentId?: string) => ({
  id: unsafeLocationId(id),
  parentId: parentId ? unsafeLocationId(parentId) : null,
});

/** A location that IS a product — a tote, bin or rack worth `price`. */
const vessel = (id: string, parentId: string, price: number) => ({
  ...loc(id, parentId),
  productPrice: price,
});

const item = (
  locationId: string,
  valuation: number | null,
  productName = "Olive oil",
) => ({ locationId: unsafeLocationId(locationId), valuation, productName });

const fixture = (locationId: string, valuation: number | null) => ({
  ...item(locationId, valuation, "Rotary dimmer"),
  placement: "installed" as const,
});

describe("rollupLocationValuations", () => {
  it("charges a vessel's own price to its PARENT, never to itself", () => {
    // "What is on this shelf" and "what is this shelf" are different
    // questions — the same split `installed` draws for fixtures.
    const result = rollupLocationValuations(
      [item("bin", 12)],
      [loc("room"), vessel("bin", "room", 199)],
    );

    const bin = result.get(unsafeLocationId("bin"))!;
    expect(bin.directValuation).toBe(12); // contents only
    expect(bin.container?.directValuation).toBe(0);

    const room = result.get(unsafeLocationId("room"))!;
    expect(room.container?.directValuation).toBe(199);
    expect(room.container?.directItemCount).toBe(1);
    // The vessel's price never leaks into the contents figures.
    expect(room.directValuation).toBe(0);
    expect(room.totalValuation).toBe(12);
  });

  it("rolls container value up the tree like contents value", () => {
    const result = rollupLocationValuations(
      [],
      [
        loc("garage"),
        loc("area", "garage"),
        vessel("cart", "area", 100),
        vessel("drawer", "cart", 25),
      ],
    );

    const garage = result.get(unsafeLocationId("garage"))!;
    expect(garage.container?.directValuation).toBe(0);
    expect(garage.container?.totalValuation).toBe(125);
    expect(garage.container?.totalItemCount).toBe(2);

    const cart = result.get(unsafeLocationId("cart"))!;
    expect(cart.container?.directValuation).toBe(25);
    expect(cart.container?.totalValuation).toBe(25);
  });

  it("leaves the container bucket empty when nothing is a product", () => {
    const result = rollupLocationValuations([item("a", 5)], [loc("a")]);
    const a = result.get(unsafeLocationId("a"))!;
    expect(a.container).toEqual({
      directValuation: 0,
      totalValuation: 0,
      directItemCount: 0,
      totalItemCount: 0,
    });
  });

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

  it("keeps fixtures out of the countable figures and rolls them up apart", () => {
    const result = rollupLocationValuations(
      [item("kitchen", 50), fixture("kitchen", 730), fixture("kitchen", null)],
      [loc("kitchen")],
    );
    const k = result.get(unsafeLocationId("kitchen"))!;

    // The headline figures answer "what could I walk over and count".
    expect(k.directValuation).toBe(50);
    expect(k.directItemCount).toBe(1);
    // An unpriced fixture must not land in missingPricing — that nudge is not
    // actionable by walking to a shelf, and it would cap coverage forever.
    expect(k.direct).toEqual({ priced: 1, missingPricing: 0, miscNoPrice: 0 });

    expect(k.installed?.directValuation).toBe(730);
    expect(k.installed?.directItemCount).toBe(2);
  });

  it("rolls installed value up the tree independently of stock", () => {
    const result = rollupLocationValuations(
      [item("kitchen", 50), fixture("kitchen", 730), fixture("pantry", 20)],
      [loc("house"), loc("kitchen", "house"), loc("pantry", "kitchen")],
    );
    const house = result.get(unsafeLocationId("house"))!;
    expect(house.totalValuation).toBe(50);
    expect(house.totalItemCount).toBe(1);
    expect(house.installed?.totalValuation).toBe(750);
    expect(house.installed?.totalItemCount).toBe(2);
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
