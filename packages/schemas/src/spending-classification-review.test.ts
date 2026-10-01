import { describe, expect, it } from "vitest";

import { spendingClassificationReviewInput } from "./spending-classification-review";

describe("native spending classification reset requests", () => {
  // Swift Codable omits nil properties, including required-nullable OpenAPI fields.
  it.each([
    {
      action: "productCategory",
      productCategoryId: "CAT-4K7M",
      spendingCategoryMode: "inherit",
    },
    {
      action: "productCategory",
      productCategoryId: "CAT-4K7M",
      spendingCategoryMode: "blocked",
    },
    { action: "vendor", vendorId: "VEN-4K7M", spendingProfile: "unspecified" },
    { action: "expenses", expenseIds: ["EXP-4K7M"] },
  ])("normalizes the omitted category for $action", (request) => {
    const field =
      request.action === "vendor"
        ? "defaultSpendingCategoryId"
        : "spendingCategoryId";
    expect(spendingClassificationReviewInput.parse(request)).toEqual({
      ...request,
      [field]: null,
    });
    expect(spendingClassificationReviewInput.parse(request)).toEqual(
      spendingClassificationReviewInput.parse({ ...request, [field]: null }),
    );
  });
});
