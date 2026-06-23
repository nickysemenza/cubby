import { describe, expect, it } from "vitest";
import { inventoryCreatePayloadData, positiveAmount } from "./inventory";

// Regression guard for the write-time invariant that replaced the Problems-page
// "invalid inventory amounts" detector: a stored quantity must be strictly
// positive. Zero means "none left" (delete the entry) and negative is
// nonsensical — both are rejected before they can reach the DB.
describe("positiveAmount", () => {
  it("accepts a positive value", () => {
    expect(positiveAmount.safeParse({ value: 2, unit: "cup" }).success).toBe(
      true,
    );
  });

  it("rejects zero", () => {
    expect(positiveAmount.safeParse({ value: 0, unit: "cup" }).success).toBe(
      false,
    );
  });

  it("rejects a negative value", () => {
    expect(positiveAmount.safeParse({ value: -1, unit: "cup" }).success).toBe(
      false,
    );
  });

  it("guards the inventory create payload", () => {
    const base = {
      productId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      locationId: "c9bf9e57-1685-4c89-bafb-ff5af830be8a",
    };
    expect(
      inventoryCreatePayloadData.safeParse({
        ...base,
        amount: { value: 1, unit: "each" },
      }).success,
    ).toBe(true);
    expect(
      inventoryCreatePayloadData.safeParse({
        ...base,
        amount: { value: 0, unit: "each" },
      }).success,
    ).toBe(false);
  });
});
