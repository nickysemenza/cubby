import { describe, expect, it } from "vitest";
import { assertQuantitySignMatchesCost } from "./helpers";

/**
 * The negative-cost half of this rule was unenforced until 2026-08-16 because
 * live rows violated it. They were normalized first, so these cases pin the
 * door shut behind that cleanup — an importer writing `+1` on a refund row is
 * exactly how the 69 violations arrived.
 */
describe("assertQuantitySignMatchesCost", () => {
  it("rejects a positive quantity on a negative-cost line", () => {
    expect(() => assertQuantitySignMatchesCost(-19.54, 1)).toThrowError(
      /negative-cost line is an exit/,
    );
  });

  it("accepts a negative quantity on a negative-cost line", () => {
    expect(() => assertQuantitySignMatchesCost(-19.54, -1)).not.toThrow();
  });

  it("rejects a negative quantity on a positive-cost line", () => {
    expect(() => assertQuantitySignMatchesCost(22.11, -1)).toThrowError(
      /positive-cost line is an acquisition/,
    );
  });

  it("accepts a positive quantity on a positive-cost line", () => {
    expect(() => assertQuantitySignMatchesCost(22.11, 1)).not.toThrow();
  });

  // The intended escape for a price concession: money came back but the item
  // was KEPT, so no unit left and negating would zero a product still owned.
  it("accepts a null quantity whatever the cost's direction", () => {
    expect(() => assertQuantitySignMatchesCost(-34.54, null)).not.toThrow();
    expect(() => assertQuantitySignMatchesCost(172.71, null)).not.toThrow();
  });

  // $0 and NULL-cost lines are where the quantity's own sign IS the fact —
  // a freebie vs a discard. Neither direction may be second-guessed here.
  it("leaves $0 and unpriced lines to their quantity's own sign", () => {
    expect(() => assertQuantitySignMatchesCost(0, 1)).not.toThrow();
    expect(() => assertQuantitySignMatchesCost(0, -1)).not.toThrow();
    expect(() => assertQuantitySignMatchesCost(null, 1)).not.toThrow();
    expect(() => assertQuantitySignMatchesCost(null, -1)).not.toThrow();
  });

  // A quantity of zero says "money moved but no unit did", which is a claim
  // about the MONEY — so only a known-negative cost can carry it. The null-cost
  // case is the one that has to be stated: `cost === null` returns early for
  // every other quantity, and letting zero ride that return is what left the
  // DB CHECK's three-valued hole reachable through the repo too (#772 review).
  it("accepts a zero quantity only against a known-negative cost", () => {
    expect(() => assertQuantitySignMatchesCost(-17.78, 0)).not.toThrow();
  });

  it.each([
    ["a positive cost — that would be a fee or an allocation", 5],
    ["a $0 line — no money moved either, so nothing happened", 0],
    ["an unclassified line — its direction is not known yet", null],
  ])("rejects a zero quantity on %s", (_label, cost) => {
    expect(() => assertQuantitySignMatchesCost(cost, 0)).toThrowError(
      /only a refund can claim/,
    );
  });
});
