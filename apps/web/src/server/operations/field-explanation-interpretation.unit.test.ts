import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import { interpretFieldValue } from "./field-explanation-interpretation";

// Interpretation must not expose wire enums, imply category amounts are
// known from line coverage, or present a monetary result as an unlabelled number.
describe("field explanation interpretation", () => {
  const field = (key: string) =>
    entityFieldModels.financialTransaction.fields.find(
      (item) => item.key === key,
    )!;

  it("uses the declared itemization label", () => {
    expect(
      interpretFieldValue(field("itemization"), "itemized_match").result,
    ).toBe("Itemized, matches");
  });

  it("separates complete category coverage from unknown amounts", () => {
    const result = interpretFieldValue(field("spendingCategorySummary"), {
      state: "single",
      categories: [],
      lineCount: 28,
      categorizedLineCount: 28,
      uncategorizedLineCount: 0,
      complete: true,
      amountsKnown: false,
    });
    expect(result.result).toBe("Single category");
    expect(result.summary).toContain("28 of 28");
    expect(result.caveats.join(" ")).toContain("amounts are unknown");
  });

  it("formats currency and preserves a negative amount", () => {
    const amountField = entityFieldModels.purchase.fields.find(
      (item) => item.key === "expenseTotal",
    )!;
    expect(interpretFieldValue(amountField, -159.84).result).toBe("-$159.84");
  });
});
