import { describe, expect, it } from "vitest";
import { resolveExpenseLineKind } from "./expense-line-kind";

describe("resolveExpenseLineKind", () => {
  it("keeps a missing role unclassified", () => {
    expect(resolveExpenseLineKind({})).toBe("unclassified");
  });

  it("resolves a missing role from an authoritative Product assignment", () => {
    expect(resolveExpenseLineKind({ productId: "PRD-4K7M" })).toBe("principal");
  });

  it("keeps the authoritative role when a draft temporarily conflicts with a Product", () => {
    expect(
      resolveExpenseLineKind({ lineKind: "tax", productId: "PRD-4K7M" }),
    ).toBe("tax");
  });

  it("preserves an explicit concrete role without reclassifying its name", () => {
    expect(resolveExpenseLineKind({ lineKind: "fee" })).toBe("fee");
  });

  it("keeps the create-only auto sentinel unresolved", () => {
    expect(resolveExpenseLineKind({ lineKind: "auto" })).toBe("unclassified");
  });

  it("resolves create auto to principal when a Product is assigned", () => {
    expect(
      resolveExpenseLineKind({
        lineKind: "auto",
        productId: "PRD-4K7M",
      }),
    ).toBe("principal");
  });
});
