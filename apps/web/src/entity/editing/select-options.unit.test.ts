import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import { presentEntitySelectOptions } from "./select-options";

describe("presentEntitySelectOptions", () => {
  it("keeps a caller's icon and color authoritative and appends sentinels", () => {
    const options = presentEntitySelectOptions("expense", "lineKind", [
      {
        value: "item_line",
        label: "Broken",
        color: "var(--custom)",
        icon: "x",
      },
    ]);

    expect(options.map(({ value, color }) => ({ value, color }))).toEqual([
      { value: "item_line", color: "var(--custom)" },
      { value: "auto", color: "var(--brand-domain-finance)" },
    ]);
    expect(options[0]?.icon).toBe("x");
    expect(options[1]?.glyph?.phosphor).toBe("Sparkle");
    expect(isValidElement(options[1]?.icon)).toBe(true);
  });
});
