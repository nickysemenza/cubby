import { describe, expect, it } from "vitest";

import { recipeSharePercent } from "./ingredient-usage";

// Failure modes: dividing by an empty cookbook, and web and native each rounding
// the share their own way (a half rounds the same everywhere or not at all).
describe("recipeSharePercent", () => {
  it("is the whole-number percent of recipes using the ingredient", () => {
    expect(recipeSharePercent(1, 3)).toBe(33);
    expect(recipeSharePercent(2, 3)).toBe(67);
    expect(recipeSharePercent(3, 3)).toBe(100);
  });

  it("rounds a half up", () => {
    expect(recipeSharePercent(1, 8)).toBe(13);
  });

  it("is 0 when the scope holds no recipes", () => {
    expect(recipeSharePercent(0, 0)).toBe(0);
  });
});
