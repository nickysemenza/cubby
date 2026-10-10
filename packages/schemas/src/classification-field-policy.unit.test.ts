import { describe, expect, it } from "vitest";

import { isFieldAllowed } from "./classification-field-policy";
import { impliedProductFeature } from "./product";

// Failure modes: food evidence loses precedence to an ISBN (an
// ingredient-linked Product with a Bookland barcode files under Books); a
// lone USDA link, ingredient, or ISBN stops implying its feature; a
// non-evidence field (model) starts implying one; an empty ingredient id or a
// zero fdc_id counts as evidence; a column-backed policy (SpendingCategory
// `productExpectation`) and a declared one disagree on what `not_allowed`
// refuses.
describe("product feature implied by identity evidence", () => {
  it.each([
    [{ ingredientId: "ING-4K7M" }, "food"],
    [{ fdc_id: 2_000_001 }, "food"],
    [{ hasIsbn: true }, "books"],
    [{ ingredientId: "ING-4K7M", hasIsbn: true }, "food"],
    [{ fdc_id: 0, ingredientId: "", hasIsbn: false }, null],
    [{}, null],
  ] as const)("%o implies %s", (evidence, feature) => {
    expect(impliedProductFeature(evidence)).toBe(feature);
  });
});

describe("one evaluator for declared and column policies", () => {
  it("evaluates a classifier stored on the governed record", () => {
    expect(isFieldAllowed("expense.lineKind", "principal", "productId")).toBe(
      true,
    );
    expect(isFieldAllowed("expense.lineKind", "tax", "productId")).toBe(false);
  });

  it("refuses food-only fields outside food, including no feature", () => {
    expect(
      isFieldAllowed("productCategory.feature", "food", "ingredientId"),
    ).toBe(true);
    expect(
      isFieldAllowed("productCategory.feature", "tools", "ingredientId"),
    ).toBe(false);
    expect(isFieldAllowed("productCategory.feature", null, "fdc_id")).toBe(
      false,
    );
    // A field the classification does not govern is always allowed.
    expect(
      isFieldAllowed("productCategory.feature", "tools", "growsPlantId"),
    ).toBe(true);
  });

  it("reads a per-row policy column the same way", () => {
    expect(
      isFieldAllowed(
        "spendingCategory.productExpectation",
        "not_allowed",
        "productId",
      ),
    ).toBe(false);
    expect(
      isFieldAllowed(
        "spendingCategory.productExpectation",
        "not_expected",
        "productId",
      ),
    ).toBe(true);
  });
});
