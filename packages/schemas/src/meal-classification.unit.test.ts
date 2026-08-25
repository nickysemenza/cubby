import { describe, expect, it } from "vitest";
import {
  MEAL_SLOT_DURATION_MINUTES,
  MEAL_TYPE_START_MINUTES,
  mealTypeRank,
  mealTypeValues,
} from "./meal-classification";

describe("meal slot times", () => {
  it("advances through the day in mealTypeValues order", () => {
    // `mealTypeValues` declaration order IS the sort order — both the calendar
    // (`mealTypeRank`) and the meals table (`array_position` in meal/crud.ts)
    // rank by it. If a new slot is appended rather than inserted at its hour,
    // the list and the clock disagree, and this catches it.
    const minutes = mealTypeValues.map((v) => MEAL_TYPE_START_MINUTES[v]);
    expect(minutes).toStrictEqual([...minutes].sort((a, b) => a - b));
    expect(new Set(minutes).size).toBe(minutes.length);
  });

  it("keeps every slot inside a single day", () => {
    for (const value of mealTypeValues) {
      const start = MEAL_TYPE_START_MINUTES[value];
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + MEAL_SLOT_DURATION_MINUTES).toBeLessThanOrEqual(24 * 60);
    }
  });

  it("ranks an unslotted meal last", () => {
    expect(mealTypeRank(null)).toBe(mealTypeValues.length);
    expect(mealTypeRank("breakfast")).toBe(0);
    // The clock-order fix: a 3pm snack precedes a 7pm dinner.
    expect(mealTypeRank("snack")).toBeLessThan(mealTypeRank("dinner"));
  });
});
