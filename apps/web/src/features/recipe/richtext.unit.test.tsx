import { describe, expect, it } from "vitest";

import { parseRichTextSafe } from "./richtext";

describe("parseRichTextSafe", () => {
  // Regression: the parser throws on a digit run followed by "e" (an
  // unfinished float exponent), which took the recipe page to its error
  // boundary for an otherwise ordinary instruction.
  it("falls back to the plain line when the parser rejects it", () => {
    const line = "Whisk the flour 3ab400edvc8 until smooth.";
    expect(parseRichTextSafe(line, ["flour"])).toEqual([
      { kind: "Text", value: line },
    ]);
  });

  it("keeps rich tokens for a line the parser accepts", () => {
    const items = parseRichTextSafe("Whisk 2 cups flour until smooth.", [
      "flour",
    ]);
    expect(items.map((item) => item.kind)).toContain("Ing");
  });
});
