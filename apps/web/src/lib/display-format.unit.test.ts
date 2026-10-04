import { measureEstimate } from "@cubby/schemas/nutrition";
import vectors from "@cubby/shared/golden-vectors/display-format.json";
import { describe, expect, it } from "vitest";

import { formatCalendarDay } from "~/lib/date-format";
import { formatCurrency } from "~/lib/number-format";
import { compactEstimateText } from "~/lib/nutrition-compact-format";
import { wasmFormat } from "~/lib/wasm";

// Currency, number, and compact estimates are formatted by one Rust
// implementation (recipebridge `display_format`, which also reads this file);
// these cases check the web bindings. Native reads the file too (CubbyKit
// DisplayFormatTests). Dates are platform code, pinned only by the vectors.
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
  // String(n); the vector pins what that prints, and the Rust formatter
  // native calls must agree with it.
  it.each(vectors.number)("number $value -> $out", ({ value, out }) => {
    expect(String(value)).toBe(out);
    expect(wasmFormat.format_number(value)).toBe(out);
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
