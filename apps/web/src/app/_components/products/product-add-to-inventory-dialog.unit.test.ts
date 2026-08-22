import { describe, expect, it } from "vitest";
import { kitsAccountedByParts } from "./product-add-to-inventory-dialog";

/**
 * The rule behind the "Already accounted for" warning.
 *
 * The tempting rule — "a kit is stocked as itself XOR as its parts" — is wrong,
 * and these cases are why: a partially opened multi-pack is legitimately both.
 */
describe("kitsAccountedByParts", () => {
  it("has no answer for a product that is not a kit", () => {
    expect(kitsAccountedByParts([])).toBeNull();
  });

  // PRD-DHXW: one component at quantity 2, both nightstands on shelves. The
  // parts account for exactly the one set the ledger says was bought.
  it("counts a single component as whole kits, not loose units", () => {
    expect(kitsAccountedByParts([{ quantity: 2, onHandUnits: 2 }])).toBe(1);
  });

  // A spare part beyond what the kits need does not conjure a second kit.
  it("floors rather than rounding a partial kit up", () => {
    expect(kitsAccountedByParts([{ quantity: 2, onHandUnits: 3 }])).toBe(1);
  });

  it("is limited by the scarcest component", () => {
    // Two batteries and one charger make one starter kit, not two.
    expect(
      kitsAccountedByParts([
        { quantity: 2, onHandUnits: 2 },
        { quantity: 1, onHandUnits: 1 },
      ]),
    ).toBe(1);
  });

  /**
   * A half-present kit accounts for zero WHOLE kits, so the caller stays quiet.
   * The missing part is a shortfall, which the variance cue already reports —
   * this rule exists to catch double-counting, not absence.
   */
  it("accounts for nothing when a component is missing entirely", () => {
    expect(
      kitsAccountedByParts([
        { quantity: 1, onHandUnits: 1 },
        { quantity: 3, onHandUnits: 0 },
      ]),
    ).toBe(0);
  });

  /**
   * The case that makes XOR wrong. PRD-M8CV is an AirTag 4-pack, two bought.
   * Open one and the four singles land on the component while the other pack
   * stays sealed on the parent: parts account for 1, the parent holds 1, and
   * 1 + 1 = 2 is exactly what was bought. No warning is correct here.
   */
  it("lets a partially opened multi-pack account for its opened half only", () => {
    expect(kitsAccountedByParts([{ quantity: 4, onHandUnits: 4 }])).toBe(1);
  });

  /**
   * Mixed units mean no single number is true for that part, so the kit's
   * accounting is unanswerable. Null suppresses the warning rather than
   * reading the part as zero and warning on a total that was never computed.
   */
  it("has no answer when a component's units cannot be summed", () => {
    expect(
      kitsAccountedByParts([
        { quantity: 1, onHandUnits: 2 },
        { quantity: 1, onHandUnits: null },
      ]),
    ).toBeNull();
  });
});
