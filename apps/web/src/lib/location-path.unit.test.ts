import { describe, expect, it } from "vitest";
import { getDefaultLocationType } from "./location-path";

describe("getDefaultLocationType", () => {
  it("should return 'room' for depth 0 (root)", () => {
    expect(getDefaultLocationType(0)).toBe("room");
  });

  it("should return 'shelf' for depth 1 (first child)", () => {
    expect(getDefaultLocationType(1)).toBe("shelf");
  });

  it("should return 'shelf' for depth 2 (second level child)", () => {
    expect(getDefaultLocationType(2)).toBe("shelf");
  });

  it("should return 'shelf' for any depth greater than 0", () => {
    expect(getDefaultLocationType(5)).toBe("shelf");
    expect(getDefaultLocationType(10)).toBe("shelf");
  });
});
