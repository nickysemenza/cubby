import { describe, expect, it } from "vitest";

import {
  legacyToolSearchToTools,
  matrixSearchFromTools,
  toolMatrixSearchSchema,
  toolsSearchSchema,
} from "./tool-search";

describe("tools route search", () => {
  it("maps every legacy matrix parameter into the Usage view", () => {
    const legacy = toolMatrixSearchSchema.parse({
      kinds: "workshop,garden",
      statuses: "in_progress,done",
      completed: "2025",
      project: "kitchen",
      page: "3",
      tool: "saw",
      floor: "250",
      group: "manufacturer",
    });

    expect(legacyToolSearchToTools(legacy)).toEqual({
      kinds: ["workshop", "garden"],
      statuses: ["in_progress", "done"],
      completed: "2025",
      project: "kitchen",
      page: 3,
      tool: "saw",
      floor: 250,
      view: "usage",
      usageGroup: "manufacturer",
    });
  });

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
