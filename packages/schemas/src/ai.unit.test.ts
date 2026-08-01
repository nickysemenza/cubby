import {
  aiLocationIdInput,
  approveDetectedInventoryItemInput,
  detectedInventoryAiResultSchema,
  MAX_DETECTED_INVENTORY_ITEMS,
} from "./ai";
import { describe, expect, it } from "vitest";

describe("AI location inputs", () => {
  it("accepts location shortcodes and rejects UUIDs", () => {
    expect(
      aiLocationIdInput.safeParse({ locationId: "LOC-2345" }).success,
    ).toBe(true);
    expect(
      approveDetectedInventoryItemInput
        .pick({ locationId: true })
        .safeParse({ locationId: "00000000-0000-4000-8000-000000000001" })
        .success,
    ).toBe(false);
  });

  it("bounds detected inventory items before product matching fan-out", () => {
    const item = {
      name: "Milk",
      manufacturer: "Acme",
      estimatedQuantity: 1,
      unit: "carton",
      category: null,
      confidence: "high" as const,
      evidence: "Visible on shelf",
      isMisc: false,
    };
    expect(
      detectedInventoryAiResultSchema.safeParse({
        items: Array.from({ length: MAX_DETECTED_INVENTORY_ITEMS }, () => item),
        summary: "Detected milk.",
      }).success,
    ).toBe(true);
    expect(
      detectedInventoryAiResultSchema.safeParse({
        items: Array.from(
          { length: MAX_DETECTED_INVENTORY_ITEMS + 1 },
          () => item,
        ),
        summary: "Too many items.",
      }).success,
    ).toBe(false);
  });
});
