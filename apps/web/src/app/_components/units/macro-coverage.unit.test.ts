import { manualUnitMapping } from "@cubby/schemas/unitmapping";
import { getNutrientUnitString } from "@cubby/usda-schemas";
import { describe, expect, it } from "vitest";

import { macroCoverage } from "./macro-coverage";

// A `100 g = X <unit>` edge, the shape USDA nutrient synthesis emits.
const edge = (unit: string) =>
  manualUnitMapping({ value: 100, unit: "g" }, { value: 1, unit });

describe("macroCoverage", () => {
  it("detects each macro by its canonical nutrient target string", () => {
    const present = macroCoverage([
      edge(getNutrientUnitString("protein")),
      edge(getNutrientUnitString("sodium")),
    ]);
    expect(present.has("protein")).toBe(true);
    expect(present.has("sodium")).toBe(true);
    expect(present.has("fat")).toBe(false);
    expect(present.has("carbs")).toBe(false);
  });

  it("counts a zero-valued macro edge — we still have the datum", () => {
    const present = macroCoverage([
      manualUnitMapping(
        { value: 100, unit: "g" },
        { value: 0, unit: getNutrientUnitString("fiber") },
      ),
    ]);
    expect(present.has("fiber")).toBe(true);
  });

  it("ignores calories, plain units, price, and non-macro nutrients", () => {
    const present = macroCoverage([
      edge("kcal"),
      edge("lb"),
      edge("dollar"),
      edge("mg potassium"),
    ]);
    expect(present.size).toBe(0);
  });

  it("matches a macro on either endpoint", () => {
    const present = macroCoverage([
      manualUnitMapping(
        { value: 1, unit: getNutrientUnitString("carbs") },
        { value: 1, unit: "serving" },
      ),
    ]);
    expect(present.has("carbs")).toBe(true);
  });
});
