import { describe, expect, it } from "vitest";
import {
  inferExpenseLineKind,
  inspectExpenseLineKind,
} from "./expense-line-kind";

describe("inferExpenseLineKind", () => {
  it.each([
    ["Sales tax", "tax"],
    ["SF sales tax — receipt #15123", "tax"],
    ["Home Depot sales tax", "tax"],
    ["Estimated tax — order 8609464", "tax"],
    ["Shipping and handling", "shipping"],
    ["UPS Ground shipping — order #194368", "shipping"],
    ["Order discount", "discount"],
    ["Handling charge — invoice 123", "fee"],
    ["Tip", "tip"],
    ["CB2 order 139003960 discount, shipping, and tax", "other_adjustment"],
    [
      "Sales tax and CA lumber-products assessment after cancellation",
      "other_adjustment",
    ],
  ] as const)("classifies %s as %s", (name, expected) => {
    expect(inferExpenseLineKind({ name })).toBe(expected);
  });

  it.each([
    "27 Gal. Storage Tote Taxi",
    "Scotch Heavy Duty Shipping Packing Tape",
    "Milwaukee Installation Driver after discount",
    "Discount Builders refund",
    "Tax preparation software",
    "Shipping tape after discount",
    "Discount Builders shipping tape",
  ])("keeps product-like name %s principal", (name) => {
    expect(inferExpenseLineKind({ name })).toBe("principal");
  });

  it("never infers an adjustment for a product-linked row", () => {
    expect(
      inferExpenseLineKind({ name: "Sales tax", productId: "PRD-4K7M" }),
    ).toBe("principal");
  });

  it("reports loose hints as ambiguous without classifying them", () => {
    expect(
      inspectExpenseLineKind({ name: "Discount Builders refund" }),
    ).toEqual({
      lineKind: "principal",
      hintedKinds: ["discount"],
      confidence: "ambiguous",
    });
  });

  it("normalizes long whitespace runs without changing classification", () => {
    expect(
      inferExpenseLineKind({ name: `Sales${" ".repeat(10_000)}tax` }),
    ).toBe("tax");
  });
});
