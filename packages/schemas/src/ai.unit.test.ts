import { aiLocationIdInput, approveDetectedInventoryItemInput } from "./ai";
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
});
