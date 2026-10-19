import { describe, expect, it } from "vitest";

import { canUpdateColumns } from "./column-update";

describe("column update routing", () => {
  it("uses one column patch for scalars and retains record logic for dependent writes", () => {
    expect(
      canUpdateColumns(
        "product",
        { stockTracked: true, notes: "Synthetic note" },
        { recordFields: ["price", "fdc_id", "labelNutrition"] },
      ),
    ).toBe(true);
    expect(
      canUpdateColumns("product", { price: 4 }, { recordFields: ["price"] }),
    ).toBe(false);
    expect(
      canUpdateColumns("product", { categoryId: null }, { recordFields: [] }),
    ).toBe(false);
    expect(
      canUpdateColumns(
        "product",
        { tags: [{ op: "add", key: "mount" }] },
        { recordFields: [] },
      ),
    ).toBe(false);
    expect(canUpdateColumns("task", { status: "done" }, undefined)).toBe(false);
  });
});
