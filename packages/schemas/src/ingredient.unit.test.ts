import { describe, expect, it } from "vitest";
import { ingredientCreateInput, ingredientUpdateData } from "./ingredient";

describe("ingredient pantry-planning metadata", () => {
  it("defaults newly created ingredients to not usually on hand", () => {
    expect(
      ingredientCreateInput.parse({ name: "Test ingredient", aliases: [] })
        .usuallyOnHand,
    ).toBe(false);
  });

  it("keeps the field optional for partial updates", () => {
    expect(ingredientUpdateData.parse({ name: "Renamed ingredient" })).toEqual({
      name: "Renamed ingredient",
    });
    expect(ingredientUpdateData.parse({ usuallyOnHand: true })).toEqual({
      usuallyOnHand: true,
    });
  });
});
