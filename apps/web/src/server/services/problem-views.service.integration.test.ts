import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { viewProblemDeclarations } from "~/entities/view-manifest";
import { findViewProblems } from "./problem-views.service";

describe("findViewProblems", () => {
  const ctx = withTestDb();

  it("runs every declared view — no entity without a list function", async () => {
    // `LIST_FN` maps entity → list function by hand, so a view declared for an
    // entity missing from it throws at request time rather than at build time.
    // Running the real roster turns that into a test failure instead of a
    // broken Problems page. The sampling contract (rows are a page, the total
    // is the population) is covered in repo/problems.integration.test.ts.
    const result = await findViewProblems(ctx.db);
    for (const { problem } of viewProblemDeclarations()) {
      expect(
        Object.hasOwn(result, problem.key),
        `view problem "${problem.key}" produced no section`,
      ).toBe(true);
      expect(result.sectionTotals[problem.key]).toBeTypeOf("number");
    }
  });
});
