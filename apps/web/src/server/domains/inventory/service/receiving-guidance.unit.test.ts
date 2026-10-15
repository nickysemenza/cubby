import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { describe, expect, it } from "vitest";

import { deriveReceivingGuidance } from "./receiving-guidance";

const row = (suffix: string, location: string, unit = "each") => ({
  id: parseShortcodeFor("inventory", `INV-${suffix}`),
  locationId: parseShortcodeFor("location", `LOC-${location}`),
  amount: { value: 2, unit },
});

// Failure modes: a counted Product defaulting to a typed-in-for-you quantity
// (blind double count); a one-of-a-kind item offered a second entry instead of
// a move; a shelf that already holds the Product offered a blind create (the
// server refuses it); the two clients disagreeing because each re-derives this.
describe("receiving guidance", () => {
  it("an uncounted Product defaults to one 'each' and creates", () => {
    expect(
      deriveReceivingGuidance({
        expectedQuantity: null,
        stock: [],
        matches: [],
      }),
    ).toEqual({
      alreadyCounted: false,
      defaultQuantity: 1,
      defaultUnit: "each",
      suggestedPlan: { kind: "create" },
      locationPlans: [],
    });
  });

  it("own stock or a stocked match marks it counted and blanks the quantity", () => {
    const ownStock = deriveReceivingGuidance({
      expectedQuantity: null,
      stock: [row("AAAA", "AAAA")],
      matches: [],
    });
    expect(ownStock.alreadyCounted).toBe(true);
    expect(ownStock.defaultQuantity).toBeNull();

    const matched = deriveReceivingGuidance({
      expectedQuantity: null,
      stock: [],
      matches: [{ inventoryCount: 3 }],
    });
    expect(matched.alreadyCounted).toBe(true);
    expect(matched.defaultQuantity).toBeNull();

    const emptyMatch = deriveReceivingGuidance({
      expectedQuantity: null,
      stock: [],
      matches: [{ inventoryCount: 0 }],
    });
    expect(emptyMatch.alreadyCounted).toBe(false);
  });

  it("a shelf already holding the Product tops up that entry in its unit", () => {
    const here = row("AAAA", "AAAA", "box");
    const elsewhere = row("BBBB", "BBBB");
    const guidance = deriveReceivingGuidance({
      expectedQuantity: null,
      stock: [here, elsewhere],
      matches: [],
    });
    expect(guidance.suggestedPlan).toEqual({ kind: "create" });
    expect(guidance.locationPlans).toEqual([
      {
        locationId: here.locationId,
        plan: { kind: "add", entryId: here.id, unit: "box" },
      },
      {
        locationId: elsewhere.locationId,
        plan: { kind: "add", entryId: elsewhere.id, unit: "each" },
      },
    ]);
  });

  it("a one-of-a-kind Product with one entry moves from every location", () => {
    const only = row("AAAA", "AAAA");
    const guidance = deriveReceivingGuidance({
      expectedQuantity: 1,
      stock: [only],
      matches: [],
    });
    expect(guidance.suggestedPlan).toEqual({
      kind: "move",
      entryId: only.id,
      fromLocationId: only.locationId,
    });
    expect(guidance.locationPlans).toEqual([]);
  });

  it("a one-of-a-kind Product with no entry, or with several, does not move", () => {
    expect(
      deriveReceivingGuidance({ expectedQuantity: 1, stock: [], matches: [] })
        .suggestedPlan,
    ).toEqual({ kind: "create" });
    const two = deriveReceivingGuidance({
      expectedQuantity: 1,
      stock: [row("AAAA", "AAAA"), row("BBBB", "BBBB")],
      matches: [],
    });
    expect(two.suggestedPlan).toEqual({ kind: "create" });
  });
});
