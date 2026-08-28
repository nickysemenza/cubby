import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { problemQueryDeclarations } from "~/entities/problem-registry";
import { viewProblemDeclarations } from "~/entities/view-manifest";

import {
  countEntitiesMissingEmbeddings,
  findEntitiesMissingEmbeddings,
  findEntitiesMissingEmbeddingsPage,
} from "../repo/problems";
import { createProductFixture, makeProductInput } from "../repo/repo.fixtures";
import { getSemanticEmbeddingConfig } from "../semantic/config";
import { executeProblem, findViewProblems } from "./problem-views.service";
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
      const focused = await executeProblem(ctx.db, problem.key);
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(focused.items, problem.key).toEqual(
        (result as unknown as Record<string, unknown>)[problem.key],
      );
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(focused.count, problem.key).toBe(
        result.sectionTotals[problem.key],
      );
    }
  });

  it("runs every exact entity Problem through its canonical list adapter", async () => {
    const entityProblems = problemQueryDeclarations().filter(
      (problem) => problem.source.kind === "entity",
    );

    expect(entityProblems).toHaveLength(35);
    for (const problem of entityProblems) {
      const result = await executeProblem(ctx.db, problem.key, {
        sampleSize: 1,
      });
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(result.count, problem.key).toBeGreaterThanOrEqual(0);
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
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
      executeProblem(ctx.db, "productsWithNoImages", { sampleSize: 1 }),
    );
    const page = await countTestDbQueries(() =>
      executeProblem(ctx.db, "productsWithNoImages", { sampleSize: 12 }),
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
    // Not exact equality, and deliberately not: the fast lane's statement
    // count is scheduling-sensitive. Originally observed as 50↔51 on CI
    // (opposite directions on the SAME commit); on 2026-08-24 it flaked at
    // delta 2 — twice on CI and once locally under a statement-level capture —
    // with NO change to this lane's code. The captured diffs showed the
    // variance is ±1–2 issuances of idempotent, fixed-roster reads (edge
    // counters, resolver lookups) sliding between the two measurement
    // windows, so the tolerance is 2, calibrated to that evidence.
    //
    // The guard is unweakened for the bug it exists to catch: a hydration
    // query per card row would add ELEVEN here, not two. Widen only with the
    // same kind of evidence (the dump below names the culprit statements) —
    // a tolerance that grows to absorb a real regression is how this
    // assertion stops meaning anything.
    //
    // On failure, the statement multiset diff between the two measurements is
    // dumped so the next failure is diagnosable from the CI log alone.
    if (Math.abs(page.queryCount - one.queryCount) > 2) {
      const tally = (list: string[]) => {
        const m = new Map<string, number>();
        for (const s of list) m.set(s, (m.get(s) ?? 0) + 1);
        return m;
      };
      const a = tally(one.statements);
      const b = tally(page.statements);
      for (const [s, n] of b) {
        const d = n - (a.get(s) ?? 0);
        if (d !== 0)
          console.error(`[query-diff] page${d > 0 ? "+" : ""}${d}× ${s}`);
      }
      for (const [s, n] of a) {
        if (!b.has(s)) console.error(`[query-diff] one-only ${n}× ${s}`);
      }
    }
    expect(Math.abs(page.queryCount - one.queryCount)).toBeLessThanOrEqual(2);
  });

  it("does not turn embedding coverage into one round trip per entity type", async () => {
    const config = getSemanticEmbeddingConfig();
    const measured = await countTestDbQueries(async () => {
      const [items, count] = await Promise.all([
        findEntitiesMissingEmbeddings(ctx.db, config),
        countEntitiesMissingEmbeddings(ctx.db, config),
      ]);
      return { items, count };
    });

    expect(measured.result.count).toBeGreaterThanOrEqual(
      measured.result.items.length,
    );
    // The old implementation issued one sample and one count query for every
    // searchable entity type. The executor may use one combined statement, or
    // retain separate combined sample/count statements, but it must stay O(1).
    expect(measured.queryCount).toBeLessThanOrEqual(2);

    const combined = await countTestDbQueries(() =>
      findEntitiesMissingEmbeddingsPage(ctx.db, config),
    );
    expect(combined.result.count).toBeGreaterThanOrEqual(
      combined.result.items.length,
    );
    expect(combined.queryCount).toBe(1);
  });

  it("counts an entity Problem without hydrating its card page", async () => {
    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        createProductFixture(
          ctx.db,
          makeProductInput({ name: `Count-only no-image ${index}` }),
          ctx.actor,
        ),
      ),
    );

    const countOnly = await countTestDbQueries(() =>
      executeProblem(ctx.db, "productsWithNoImages", { mode: "count" }),
    );
    const sampled = await countTestDbQueries(() =>
      executeProblem(ctx.db, "productsWithNoImages", { sampleSize: 3 }),
    );

    expect(countOnly.result.count).toBe(3);
    expect(countOnly.result.items).toEqual([]);
    expect(countOnly.result.data).toEqual([]);
    expect(countOnly.queryCount).toBeLessThan(sampled.queryCount);
  });

  it("dispatches every derived Problem through its typed diagnostic adapter", async () => {
    const derivedProblems = problemQueryDeclarations().filter(
      (problem) => problem.source.kind === "derived",
    );

    expect(derivedProblems).toHaveLength(18);
    for (const problem of derivedProblems) {
      const result = await executeProblem(ctx.db, problem.key, {
        sampleSize: 1,
      });
      const counted = await executeProblem(ctx.db, problem.key, {
        mode: "count",
      });
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(result.source.kind, problem.key).toBe("derived");
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(result.count, problem.key).toBeGreaterThanOrEqual(0);
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(result.items.length, problem.key).toBeLessThanOrEqual(1);
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(counted.count, problem.key).toBe(result.count);
      // oxlint-disable-next-line vitest/valid-expect -- The second argument is an assertion label for this table-driven check.
      expect(counted.items, problem.key).toEqual([]);
      // A provider failure is explicit state, never an empty healthy result.
      expect(["healthy", "stale", "unavailable"]).toContain(
        result.status.state,
      );
    }
  });
});
