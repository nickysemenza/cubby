import { recommendationWorkbenchSearch } from "@cubby/schemas/recommendations";
import { describe, expect, it } from "vitest";

describe("recommendations workbench route search", () => {
  it("allows direct entry to render the route-owned empty guidance", () => {
    expect(recommendationWorkbenchSearch.parse({})).toEqual({});
  });
});
