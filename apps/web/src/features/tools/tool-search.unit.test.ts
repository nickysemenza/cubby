import { describe, expect, it } from "vitest";

import { matrixSearchFromTools, toolsSearchSchema } from "./tool-search";

describe("tools route search", () => {
  it("keeps gallery and Usage filters in separate URL fields", () => {
    const canonical = toolsSearchSchema.parse({
      view: "gallery",
      q: "drill",
      galleryGroup: "location",
      section: "garage",
      usageGroup: "trade",
      floor: 100,
    });

    expect(matrixSearchFromTools(canonical)).toMatchObject({
      group: "trade",
      floor: 100,
    });
    expect(canonical).toMatchObject({
      q: "drill",
      galleryGroup: "location",
      section: "garage",
    });
  });
});
