import { describe, expect, it } from "vitest";

import { skillReferences } from "./import-run-skill-references";

describe("skillReferences", () => {
  // Regression: the globs once resolved one directory short of the repository
  // root, so Pi's photo Runs loaded each skill with no reference files.
  it("bundles every referenced skill's reference files", () => {
    for (const files of Object.values(skillReferences))
      expect(Object.keys(files).length).toBeGreaterThan(0);
  });
});
