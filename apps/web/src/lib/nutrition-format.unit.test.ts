import { describe, expect, it } from "vitest";

import { estimateStatusText } from "~/lib/nutrition-format";

// The estimate text itself is pinned by golden-vectors/display-format.json
// (display-format.unit.test.ts); this covers the accessible status detail.
describe("estimateStatusText", () => {
  it("does not turn absent data into a zero", () => {
    expect(
      estimateStatusText({ status: "unavailable", reason: "no_data" }),
    ).toBe("Unavailable: no nutrition data");
  });
});
