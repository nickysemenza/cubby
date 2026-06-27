import type { Amount } from "@cubby/schemas/codec";
import { manualUnitMapping } from "@cubby/schemas/unitmapping-responses";
import { describe, expect, it } from "vitest";
import {
  BASE_KINDS,
  conversionCoverage,
  gradedKinds,
  USDA_KINDS,
} from "./conversion-coverage";

const map = (a: Amount, b: Amount) => manualUnitMapping(a, b, "test");

// weight↔volume (density), weight↔calories, weight↔money — enough edges that the
// graph can reach the other base-kind pairs by chaining through grams.
const density = () => map({ value: 1, unit: "cup" }, { value: 240, unit: "g" });
const calories = () =>
  map({ value: 100, unit: "g" }, { value: 80, unit: "kcal" });
const price = () => map({ value: 100, unit: "g" }, { value: 5, unit: "$" });

describe("conversionCoverage tiers", () => {
  it("no mappings → none, for both universes", () => {
    expect(conversionCoverage([], BASE_KINDS).tier).toBe("none");
    expect(conversionCoverage([], USDA_KINDS).tier).toBe("none");
  });

  it("4-kind: full weight↔volume↔money↔calories → complete", () => {
    const cov = conversionCoverage(
      [density(), calories(), price()],
      BASE_KINDS,
    );
    expect(cov.tier).toBe("complete");
  });

  it("no price → 4-kind 'good' but 3-kind USDA 'complete' (the price-exclusion win)", () => {
    const mappings = [density(), calories()];
    expect(conversionCoverage(mappings, BASE_KINDS).tier).toBe("good");
    expect(conversionCoverage(mappings, USDA_KINDS).tier).toBe("complete");
  });

  it("only weight↔calories → 4-kind 'partial', 3-kind USDA 'good'", () => {
    const mappings = [calories()];
    expect(conversionCoverage(mappings, BASE_KINDS).tier).toBe("partial");
    expect(conversionCoverage(mappings, USDA_KINDS).tier).toBe("good");
  });
});

describe("gradedKinds (N/A opt-out)", () => {
  it("no opt-outs → all four base kinds", () => {
    expect(gradedKinds()).toEqual([...BASE_KINDS]);
    expect(gradedKinds(null)).toEqual([...BASE_KINDS]);
    expect(gradedKinds([])).toEqual([...BASE_KINDS]);
  });

  it("subtracts the marked-N/A kinds (preserving BASE_KINDS order)", () => {
    expect(gradedKinds(["volume"])).toEqual(["weight", "money", "calories"]);
    expect(gradedKinds(["volume", "calories"])).toEqual(["weight", "money"]);
  });

  it("volume N/A lets a weight↔money↔calories item read 'complete'", () => {
    // A whole-lemon-style item: price + grams + calories, but no volume. Graded
    // over all four it's 'good' (volume unreachable); with volume N/A it's
    // 'complete' — exactly the fix that drops it off the gap worklist.
    const mappings = [price(), calories()];
    expect(conversionCoverage(mappings, BASE_KINDS).tier).toBe("good");
    expect(conversionCoverage(mappings, gradedKinds(["volume"])).tier).toBe(
      "complete",
    );
  });
});
