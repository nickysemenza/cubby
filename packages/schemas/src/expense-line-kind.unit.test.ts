import { describe, expect, it } from "vitest";
import { resolveExpenseLineKind } from "./expense-line-kind";

describe("resolveExpenseLineKind", () => {
  it("keeps a missing role unclassified without a Product", () => {
    expect(resolveExpenseLineKind({})).toBe("unclassified");
  });

  it("treats a Product assignment as principal", () => {
    expect(resolveExpenseLineKind({ productId: "PRD-4K7M" })).toBe("principal");
  });

  it("rejects an explicit incompatible role for a Product line", () => {
    expect(() =>
      resolveExpenseLineKind({ lineKind: "tax", productId: "PRD-4K7M" }),
    ).toThrow("Only principal Expenses may link a Product");
  });

  it("preserves an explicit concrete role without reclassifying its name", () => {
    expect(resolveExpenseLineKind({ lineKind: "fee" })).toBe("fee");
  });

  it("keeps the create-only auto sentinel unresolved", () => {
    expect(resolveExpenseLineKind({ lineKind: "auto" })).toBe("unclassified");
  });
});
