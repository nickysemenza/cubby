import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { projectImageSummaries } from "./image.server";

describe("Image operations", () => {
  it("rejects a project summary zip when resolution drops a project", () => {
    expect(() =>
      projectImageSummaries(
        [
          testShortcode("project", "PRJ-4K7M"),
          testShortcode("project", "PRJ-7M2P"),
        ],
        ["project-uuid"],
        {},
      ),
    ).toThrow("Project resolution changed result cardinality");
  });
});
