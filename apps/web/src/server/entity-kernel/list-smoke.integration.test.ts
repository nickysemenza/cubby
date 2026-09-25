/**
 * Structural regression guard for the CUBBY-11R bug class, not a single fix.
 *
 * Every kernel entity list pairs a Drizzle relational `findMany` rows query
 * (which aliases the root table to its lowercase name and rewrites Column
 * objects — but NOT `sql.raw` strings or nested PgSelect builders) with an
 * unaliased `$count`/plain-select over the SAME where clause. A predicate
 * that reaches the outer row by raw table name, or via a correlated
 * sub-select builder, compiles on one leg and throws `invalid reference to
 * FROM-clause entry for table "X"` (or the mirror `missing FROM-clause entry
 * for table "x"`) on the other — but only when that specific filter or sort
 * is actually used, so a new instance ships to production silently.
 *
 * This file drives EVERY declared filter (one at a time) and EVERY declared
 * sort field, for EVERY kernel entity with a list operation, through the real
 * kernel against real Postgres. Postgres raises an alias mismatch at PLAN
 * time, so even a query matching zero rows exercises the SQL — the one
 * exception is a filter that must RESOLVE a shortcode to a real row (e.g.
 * `gardenEntry.plantingId`): an unresolvable id short-circuits to
 * `sql\`false\`` before the buggy predicate is ever built, which is why this
 * file seeds a small real reference universe and substitutes real shortcodes
 * into generated filter samples wherever their prefix matches a seeded
 * entity.
 *
 * Harness note: `withTestDb()` truncates every table before EVERY `it`, so a
 * `beforeAll` seed never survives to see a test body (`ctx.db` is not even
 * reachable inside `beforeAll`). Reseeding the ~20-entity reference universe
 * before each of the several hundred (entity, filter/sort) cases below would
 * dominate this file's runtime, so the whole matrix runs inside ONE `it`
 * with a single seed; each case is still individually identifiable — a
 * thrown error is caught, labeled with its (entity, key) pair, and collected
 * so one bad pair never hides another.
 *
 * The same matrix also guards a second bug class: a filter the list route
 * accepts and validates but never applies. `imageSighting.imageId` shipped
 * that way — the list showed the filter chip and returned every sighting.
 * For each seeded entity, every id-shaped filter is re-run with a
 * well-formed shortcode that names no row, and must return nothing.
 */
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { ingredientFiltersSchema } from "@cubby/schemas/ingredient";
import { SHORTCODE_BODY_LENGTH, SHORTCODE_CHARS } from "@cubby/shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_KERNEL_ENTITIES } from "~/server/entity-kernel/contracts";
import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";
import {
  buildKernelContext,
  collectShortcodePaths,
  describeError,
  type JsonPath,
  prefixOf,
  seedReferenceUniverse,
  setAtPath,
  SHORTCODE_PATTERN,
  SKIPPED_ENTITIES,
} from "~/server/entity-kernel/reference-universe.fixtures";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { ingredientList } from "~/server/repo/ingredient";

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- the mock() walker trade-off in reference-universe.fixtures.ts */
/**
 * Whole-number filters (e.g. `totalMinutesMin`) are backed by an `integer`
 * column, but their Zod schema is often a plain `z.number()` with no `.int()`
 * check, so `mock()` happily produces a fractional sample and Postgres
 * rejects it with `invalid input syntax for type integer` — a test-harness
 * artifact, not the FROM-clause bug this file hunts. Rounding every
 * generated number is always safe for the columns that DO tolerate a
 * fraction (`numeric`/`money`), so this is applied unconditionally rather
 * than trying to infer which filter fields are integer-backed.
 */
function roundNumbers(value: unknown): unknown {
  if (typeof value === "number")
    return Number.isInteger(value) ? value : Math.round(value);
  if (Array.isArray(value)) return value.map(roundNumbers);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, roundNumbers(item)]),
    );
  }
  return value;
}
/**
 * The same sample with every shortcode swapped for a well-formed code of the
 * same prefix that names no row, or `null` when the sample is not purely
 * shortcodes (a string or a list of strings) — only those have an obvious
 * "matches nothing" value.
 */
function unmatchedIdSample(
  value: unknown,
  seeded: ReadonlySet<string>,
): string | string[] | null {
  const codes = [value].flat();
  if (
    codes.length === 0 ||
    !codes.every((c) => typeof c === "string" && SHORTCODE_PATTERN.test(c))
  )
    return null;
  const swapped = codes.map((code) => {
    const prefix = prefixOf(String(code)) ?? "";
    const body = [...SHORTCODE_CHARS]
      .map((ch) => `${prefix}${ch.repeat(SHORTCODE_BODY_LENGTH)}`)
      .find((candidate) => !seeded.has(candidate));
    if (body === undefined) throw new Error(`no unused ${prefix} code`);
    return body;
  });
  return Array.isArray(value) ? swapped : (swapped[0] ?? null);
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns */

function filterFieldsOf(entity: EntityKernelEntity): Record<string, z.ZodType> {
  const schema = ENTITY_KERNEL_BINDINGS[entity].schemas.filters;
  return schema instanceof z.ZodObject ? schema.shape : {};
}

type FilterSample =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/**
 * Generate a sample value for one filter field, then replace any generated
 * shortcode whose prefix matches a seeded entity with the REAL seeded
 * shortcode — a random `mock()` shortcode never resolves to a row, which
 * hides exactly the bug class this file exists to catch (see header).
 */
function buildFilterSample(
  fieldSchema: z.ZodType,
  seed: number,
  shortcodeByPrefix: ReadonlyMap<string, string>,
): FilterSample {
  let raw: unknown;
  try {
    raw = mock(fieldSchema, { fillOptionals: true, seed });
  } catch (err) {
    return {
      ok: false,
      reason: `mock() could not synthesize a sample: ${describeError(err)}`,
    };
  }
  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const wrapper: Record<string, unknown> = { value: raw };
  const found: Array<{ path: JsonPath; code: string }> = [];
  collectShortcodePaths(raw, ["value"], found);
  for (const { path, code } of found) {
    const prefix = prefixOf(code);
    const real = prefix ? shortcodeByPrefix.get(prefix) : undefined;
    if (real) setAtPath(wrapper, path, real);
  }
  return { ok: true, value: roundNumbers(wrapper.value) };
}

describe("entity list smoke — dual relational/count FROM-clause aliasing", () => {
  const ctx = withTestDb();

  it("resolves every declared filter and sort for every listable entity", async () => {
    const universe = await seedReferenceUniverse(ctx.db);
    const kernelCtx = buildKernelContext(ctx.db);

    const failures: string[] = [];
    const skipped: string[] = [];
    let seed = 1000;
    let caseCount = 0;
    const listCases: Array<() => Promise<void>> = [];

    const runListCase = async (
      label: string,
      run: () => Promise<{ items: unknown; meta: { totalCount: number } }>,
    ) => {
      caseCount += 1;
      try {
        const result = await run();
        if (!Array.isArray(result.items)) {
          failures.push(`${label}: items was not an array`);
          return;
        }
        if (result.items.length > result.meta.totalCount) {
          failures.push(
            `${label}: items.length (${result.items.length}) exceeded meta.totalCount (${result.meta.totalCount})`,
          );
        }
      } catch (err) {
        failures.push(`${label}: ${describeError(err)}`);
      }
    };

    const seededCodes = new Set(universe.shortcodeByPrefix.values());
    for (const entity of ENTITY_KERNEL_ENTITIES) {
      const binding = ENTITY_KERNEL_BINDINGS[entity];
      const filterFields = filterFieldsOf(entity);
      const unfiltered = await executeEntity(kernelCtx, {
        action: "list",
        entity,
        filters: {},
        pagination: { pageIndex: 0, pageSize: 1 },
      }).catch(() => null);
      const hasRows = (unfiltered?.meta.totalCount ?? 0) > 0;

      for (const [key, fieldSchema] of Object.entries(filterFields)) {
        seed += 1;
        const sample = buildFilterSample(
          fieldSchema,
          seed,
          universe.shortcodeByPrefix,
        );
        if (!sample.ok) {
          skipped.push(`${entity} filter ${key}: ${sample.reason}`);
          continue;
        }
        listCases.push(() =>
          runListCase(`${entity} filter ${key}`, () =>
            executeEntity(kernelCtx, {
              action: "list",
              entity,
              filters: { [key]: sample.value },
              pagination: { pageIndex: 0, pageSize: 20 },
            }),
          ),
        );

        const unmatched = hasRows
          ? unmatchedIdSample(sample.value, seededCodes)
          : null;
        if (unmatched === null) continue;
        listCases.push(async () => {
          caseCount += 1;
          try {
            const result = await executeEntity(kernelCtx, {
              action: "list",
              entity,
              filters: { [key]: unmatched },
              pagination: { pageIndex: 0, pageSize: 1 },
            });
            if (result.meta.totalCount !== 0)
              failures.push(
                `${entity} filter ${key}=${String(unmatched)}: matched ${result.meta.totalCount} row(s) — the filter is accepted but not applied`,
              );
          } catch (err) {
            failures.push(
              `${entity} filter ${key} (unmatched): ${describeError(err)}`,
            );
          }
        });
      }

      for (const orderBy of binding.sort.fields) {
        listCases.push(() =>
          runListCase(`${entity} sort ${orderBy} asc`, () =>
            executeEntity(kernelCtx, {
              action: "list",
              entity,
              filters: {},
              sort: [{ orderBy, direction: "asc" }],
              pagination: { pageIndex: 0, pageSize: 20 },
            }),
          ),
        );
      }
    }

    // All probes only read the seeded universe. Bound concurrency below the
    // file's pool size so independent SQL plans can overlap without making
    // this one integration file monopolize PostgreSQL during the full suite.
    let nextCase = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (nextCase < listCases.length) {
          const run = listCases[nextCase++];
          if (!run) throw new Error("Missing list probe");
          await run();
        }
      }),
    );

    // The kernel's `filters.ids` scan and per-entity `list()` both go through
    // the relational builder, but ingredient's `readIntent: "ids"` bulk-scan
    // path is a repo-level entry point the kernel never calls — reach it
    // directly for its two computed (correlated-subquery) sort keys.
    for (const orderBy of generatedEntitySort.ingredient.computed) {
      caseCount += 1;
      try {
        const result = await ingredientList(
          ctx.db,
          ingredientFiltersSchema.parse({}),
          [{ orderBy, direction: "asc" }],
          { pageIndex: 0, pageSize: 20 },
          "ids",
        );
        if (!Array.isArray(result.data)) {
          failures.push(
            `ingredient ids-intent sort ${orderBy}: data was not an array`,
          );
        }
      } catch (err) {
        failures.push(
          `ingredient ids-intent sort ${orderBy}: ${describeError(err)}`,
        );
      }
    }

    // A filter the matrix silently skipped is a filter nothing guards, so a
    // new skip has to show up as a test change, not a log line.
    expect(skipped).toEqual([]);
    expect(universe.skippedEntities.map((s) => s.entity)).toEqual([
      ...SKIPPED_ENTITIES.keys(),
    ]);

    // Joined, not `toEqual([])`: vitest elides a failing array to `…(n)`,
    // which would hide exactly the (entity, key) names this file exists to
    // report.
    expect(
      failures.join("\n"),
      `${failures.length} of ${caseCount} list case(s) threw a FROM-clause/plan error or ignored a filter:\n${failures.join("\n")}\n`,
    ).toBe("");
  }, 180_000); // The full entity matrix still needs headroom under CI load.
});
