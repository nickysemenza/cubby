import { recommendationWorkbenchSearch } from "@cubby/schemas/recommendations";
import { describe, expect, it } from "vitest";

describe("recommendation workbench link", () => {
  it("accepts only a product shortcode and no recommendation payload", () => {
    expect(
      recommendationWorkbenchSearch.safeParse({
        kind: "product-related",
        source: "PRD-ABCD",
      }).success,
    ).toBe(true);
    expect(
      recommendationWorkbenchSearch.safeParse({
        kind: "duplicate-product",
        source: "PRD-ABCD",
      }).success,
    ).toBe(true);
    expect(
      recommendationWorkbenchSearch.safeParse({
        kind: "product-related",
        source: "not-a-shortcode",
        score: 0.99,
      }).success,
    ).toBe(false);
  });
});
