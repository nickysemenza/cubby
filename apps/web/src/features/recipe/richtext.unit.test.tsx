import { describe, expect, it } from "vitest";

import { parseRichTextSafe } from "./richtext";

describe("parseRichTextSafe", () => {
  it("keeps rich tokens for a line the parser accepts", () => {
    const items = parseRichTextSafe("Whisk 2 cups flour until smooth.", [
      "flour",
    ]);
    expect(items.map((item) => item.kind)).toContain("Ing");
  });
});
