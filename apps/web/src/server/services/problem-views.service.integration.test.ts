import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { problemQueryDeclarations } from "~/entities/problem-registry";
import { viewProblemDeclarations } from "~/entities/view-manifest";
import { createProductFixture, makeProductInput } from "../repo/repo.fixtures";
import { findViewProblems, runProblem } from "./problem-views.service";
import { findFastProblems } from "./problems.service";

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

  it("runs every exact entity Problem through its canonical list adapter", async () => {
    const entityProblems = problemQueryDeclarations().filter(
      (problem) => problem.source.kind === "entity",
    );

    expect(entityProblems).toHaveLength(34);
    for (const problem of entityProblems) {
      const result = await runProblem(ctx.db, problem.key, { sampleSize: 1 });
      expect(result.count, problem.key).toBeGreaterThanOrEqual(0);
      expect(result.data.length, problem.key).toBeLessThanOrEqual(1);
    }
  });

  it("keeps an exact Problem list query count flat as its card page grows", async () => {
    // `productsWithNoImages` has no fixture-only special case: these are the
    // same ordinary product rows the route lists.  The two calls exercise the
    // canonical list/count path with one and twelve returned rows.  Equality,
    // rather than a wall-time or hand-picked query budget, makes an accidental
    // per-card-row hydration query fail deterministically.
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createProductFixture(
          ctx.db,
          makeProductInput({ name: `No-image performance ${index}` }),
          ctx.actor,
        ),
      ),
    );

    const one = await countTestDbQueries(() =>
      runProblem(ctx.db, "productsWithNoImages", { sampleSize: 1 }),
    );
    const page = await countTestDbQueries(() =>
      runProblem(ctx.db, "productsWithNoImages", { sampleSize: 12 }),
    );

    expect(one.result.count).toBe(12);
    expect(page.result.count).toBe(12);
    expect(one.result.data).toHaveLength(1);
    expect(page.result.data).toHaveLength(12);
    expect(page.queryCount).toBe(one.queryCount);
  });

  it("keeps the fast lane's SQL shape flat as an exact card fills", async () => {
    const create = (index: number) =>
      createProductFixture(
        ctx.db,
        makeProductInput({ name: `Fast-lane no-image ${index}` }),
        ctx.actor,
      );
    await create(0);
    const one = await countTestDbQueries(() => findFastProblems(ctx.db));

    await Promise.all(
      Array.from({ length: 11 }, (_, index) => create(index + 1)),
    );
    const page = await countTestDbQueries(() => findFastProblems(ctx.db));

    expect(one.result.productsWithNoImages).toHaveLength(1);
    expect(page.result.productsWithNoImages).toHaveLength(12);
    expect(page.queryCount).toBe(one.queryCount);
  });

  it("dispatches every derived Problem through its typed diagnostic adapter", async () => {
    const derivedProblems = problemQueryDeclarations().filter(
      (problem) => problem.source.kind === "derived",
    );

    expect(derivedProblems).toHaveLength(17);
    for (const problem of derivedProblems) {
      const result = await runProblem(ctx.db, problem.key, { sampleSize: 1 });
      expect(result.source.kind, problem.key).toBe("derived");
      expect(result.count, problem.key).toBeGreaterThanOrEqual(0);
      expect(result.items.length, problem.key).toBeLessThanOrEqual(1);
      // A provider failure is explicit state, never an empty healthy result.
      expect(["healthy", "stale", "unavailable"]).toContain(
        result.status.state,
      );
    }
  });
});
