import vectors from "@cubby/shared/golden-vectors/display-format.json";
import { describe, expect, it } from "vitest";

import { tryFormatAmount } from "./format-amount";

// Amounts are formatted by recipebridge `format_amount_labeled`; its Rust tests
// and CubbyKit ValueFormatTests read the same vectors.
describe("tryFormatAmount golden vectors", () => {
  it.each(vectors.amount)(
    "amount $value $unit -> $out",
    ({ out, ...vector }) => {
      expect(
        tryFormatAmount({
          value: vector.value,
          unit: vector.unit,
          ...("upper" in vector ? { upper_value: vector.upper } : {}),
        }),
      ).toBe(out);
    },
  );
});
