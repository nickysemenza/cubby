import { describe, expect, it } from "vitest";

import {
  isDetectedItemCoveredByInventoryName,
  selectDetectionImages,
} from "./location-vision";

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

describe("selectDetectionImages", () => {
  const images = ["IMG-A", "IMG-B", "IMG-C", "IMG-D", "IMG-E", "IMG-F"].map(
    (id) => ({ id }),
  );

  it("keeps the first five images when no ids are given", () => {
    expect(selectDetectionImages(images).map((image) => image.id)).toEqual([
      "IMG-A",
      "IMG-B",
      "IMG-C",
      "IMG-D",
      "IMG-E",
    ]);
  });

  it("analyzes only the requested image, even past the first five", () => {
    expect(selectDetectionImages(images, ["IMG-F"])).toEqual([{ id: "IMG-F" }]);
  });

  it("ignores ids the location does not hold", () => {
    expect(selectDetectionImages(images, ["IMG-Z"])).toEqual([]);
  });
});
