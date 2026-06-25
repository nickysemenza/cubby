import { describe, expect, it } from "vitest";
import { requiredName } from "./common";
import { ingredientCreateInput } from "./ingredient";
import { locationCreateInput } from "./location";
import { productCreateInput } from "./product";
import { recipeCreateInput } from "./recipe";

// Regression: core-entity create inputs must reject blank / whitespace-only
// names. The constraint lives on the *input* schemas only (never the *Base/*Out
// reused for reads), so this guards new writes without breaking reads of any
// pre-existing empty-name rows.
describe("requiredName", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["tab/newline only", "\t\n"],
  ])("rejects %s", (_label, value) => {
    expect(requiredName().safeParse(value).success).toBe(false);
  });

  it("trims and accepts a real name", () => {
    const parsed = requiredName().parse("  Flour  ");
    expect(parsed).toBe("Flour");
  });
});

describe("core entity create inputs reject blank names", () => {
  it("recipeCreateInput", () => {
    expect(recipeCreateInput.safeParse({ name: "", meta: {} }).success).toBe(
      false,
    );
  });

  it("locationCreateInput", () => {
    expect(
      locationCreateInput.safeParse({ name: "  ", type: "container" }).success,
    ).toBe(false);
  });

  it("productCreateInput", () => {
    expect(productCreateInput.safeParse({ name: "" }).success).toBe(false);
  });

  it("ingredientCreateInput", () => {
    expect(
      ingredientCreateInput.safeParse({ name: "", aliases: [] }).success,
    ).toBe(false);
  });
});
