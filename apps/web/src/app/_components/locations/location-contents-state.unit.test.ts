import { describe, expect, it } from "vitest";
import { locationContentsVisibility } from "./location-contents-state";

describe("locationContentsVisibility", () => {
  it("treats a child-only parent as structured rather than empty", () => {
    expect(locationContentsVisibility(2, 0)).toEqual({
      empty: false,
      showChildren: true,
      showDirectItems: false,
    });
  });

  it("keeps both groups when the parent also stores direct items", () => {
    expect(locationContentsVisibility(2, 3)).toEqual({
      empty: false,
      showChildren: true,
      showDirectItems: true,
    });
  });

  it("preserves the true empty state", () => {
    expect(locationContentsVisibility(0, 0)).toEqual({
      empty: true,
      showChildren: false,
      showDirectItems: false,
    });
  });
});
