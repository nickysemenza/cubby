import { describe, expect, it } from "vitest";

import { isDetectedItemCoveredByInventoryName } from "./location-vision";

// Pure string comparison — two names in, a boolean out. Lived in
// location-vision.integration.test.ts until the test-tier audit; it never used
// that file's `withTestDb()` context. Assertions unchanged.
describe("isDetectedItemCoveredByInventoryName", () => {
  it("treats a generic cached detection as covered by a more specific inventoried product", () => {
    expect(
      isDetectedItemCoveredByInventoryName("drop cloth", "plastic drop cloth"),
    ).toBe(true);
    expect(
      isDetectedItemCoveredByInventoryName("plastic tarp", "blue plastic tarp"),
    ).toBe(true);
  });

  it("does not dedupe single-token broad matches", () => {
    expect(isDetectedItemCoveredByInventoryName("tarp", "tarp clips")).toBe(
      false,
    );
  });
});
