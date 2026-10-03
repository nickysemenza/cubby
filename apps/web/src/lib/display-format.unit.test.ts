import { measureEstimate } from "@cubby/schemas/nutrition";
import vectors from "@cubby/shared/golden-vectors/display-format.json";
import { describe, expect, it } from "vitest";

import { formatCalendarDay } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import { compactEstimateText } from "~/lib/nutrition-format";

// Native reads the same file (CubbyKit DisplayFormatTests), so a display
// format cannot be changed on one client without the other failing.
describe("display-format golden vectors", () => {
  it.each(vectors.currency)("currency $value -> $out", ({ value, out }) => {
    expect(formatCurrency(value)).toBe(out);
  });

  it.each(vectors.signedCurrency)(
    "signedCurrency $value -> $out",
    ({ value, out }) => {
      expect(formatCurrency(value)).toBe(out);
    },
  );

  it.each(vectors.plainDate)("plainDate $in -> $out", (vector) => {
    expect(formatCalendarDay(vector.in, "dateShort")).toBe(vector.out);
  });

  // The generic renderer hands a bare number field to React, which prints
  // String(n); the vector pins what that prints so native matches it.
  it.each(vectors.number)("number $value -> $out", ({ value, out }) => {
    expect(String(value)).toBe(out);
  });

  it.each(vectors.compactEstimate)(
    "compactEstimate $unit $estimate.status -> $out",
    ({ unit, estimate, out }) => {
      expect(
        compactEstimateText(
          measureEstimate.parse(estimate),
          unit === "kcal" ? "kcal" : "macro",
        ),
      ).toBe(out);
    },
  );
});
