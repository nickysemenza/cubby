import { describe, expect, it } from "vitest";
import { withUSDAListIdentity } from "./usdafoodlist";

describe("USDAFoodList", () => {
  it("adapts the external FDC identity to the shared list contract", () => {
    const row = withUSDAListIdentity({
      fdc_id: 12345,
      foodInfo: { description: "Example food" },
    });

    expect(row).toMatchObject({ id: "12345", name: "Example food" });
  });
});
