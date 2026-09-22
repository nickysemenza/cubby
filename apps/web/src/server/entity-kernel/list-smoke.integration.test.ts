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
 */
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { ingredientFiltersSchema } from "@cubby/schemas/ingredient";
import { testUserId } from "@cubby/schemas/testing";
import {
  seedEntity,
  TEST_HOME_SHORTCODE,
  TEST_USER_ID,
  withTestDb,
} from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "~/lib/test/mock-schema";
import type { Database } from "~/server/db";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_KERNEL_ENTITIES } from "~/server/entity-kernel/contracts";
import type { EntityKernelEntity } from "~/server/entity-kernel/contracts";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { ingredientList } from "~/server/repo/ingredient";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

// Entities the kernel cannot create through `seedEntity` (createInput is
// `null` — see `entity-bindings.gen.ts`). Their list surface is still
// exercised below; only the seed step is skipped. A `Map` rather than a
// dictionary object, since only entity keys that actually opt out belong
// here.
const SKIPPED_ENTITIES = new Map<EntityKernelEntity, string>([
  [
    "image",
    "createInput is null — image creation is an upload workflow, not a kernel create",
  ],
]);

type JsonPath = Array<string | number>;

const SHORTCODE_PATTERN = /^[A-Z]{2,}-[A-Za-z0-9]+$/;
const prefixOf = (code: string): string | undefined =>
  /^([A-Z]{2,}-)/.exec(code)?.[1];

/**
 * `mock()` walks an arbitrary Zod schema and its output shape is therefore
 * genuinely heterogeneous by construction — every declared filter/createInput
 * schema in the entity roster shapes it differently, so there is no single
 * concrete domain type to assign it ahead of time. This block is the one
 * generic reflection layer that walks and rebuilds that data (path
 * collection, in-place patching, and integer rounding); everywhere else in
 * this file works with concrete, named types. Mirrors the same trade-off
 * `packages/schemas/src/entity-definitions/definition.ts`'s
 * `valueIsMissingAt` parser-boundary walker makes for the same reason.
 */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- see block comment above */

/** Walk any mock()-generated value, reporting every shortcode-shaped string. */
function collectShortcodePaths(
  value: unknown,
  path: JsonPath,
  out: Array<{ path: JsonPath; code: string }>,
): void {
  if (typeof value === "string") {
    if (SHORTCODE_PATTERN.test(value)) out.push({ path, code: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      collectShortcodePaths(item, [...path, index], out);
    return;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, item] of Object.entries(value))
      collectShortcodePaths(item, [...path, key], out);
  }
}

function setAtPath(
  target: Record<string, unknown>,
  path: JsonPath,
  value: unknown,
): void {
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = String(path[i]);
    const next = path[i + 1];
    const existing = cursor[key];
    if (existing === null || typeof existing !== "object")
      cursor[key] = typeof next === "number" ? [] : {};
    // SAFETY: the branch above just assigned an array or a plain object when
    // `cursor[key]` wasn't already one, so it is always walkable here.
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = path.at(-1);
  if (lastKey !== undefined) cursor[String(lastKey)] = value;
}

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
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */

/**
 * Drizzle wraps the real Postgres error (e.g. `invalid reference to
 * FROM-clause entry for table "X"`) as `.cause` under a generic "Failed
 * query" message — surface both so a failure names the actual SQL problem.
 * `TCaught` (not an `unknown` parameter) matches how a caught value's type
 * arrives at this boundary: whatever the try block threw.
 */
function describeError<TCaught>(err: TCaught): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  // Drizzle's own message embeds the full query text (hundreds of lines for
  // an inherited-column list); the Postgres cause is the one-line diagnosis.
  const summary =
    err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
  return cause ? `${cause} (${summary})` : summary;
}

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

/**
 * Probe an entity's createInput once to discover which required fields are
 * shortcode references, and patch them onto REAL seeded shortcodes. `mock()`
 * always resolves a bare `.union()` to its first option and omits
 * `.optional()` fields deterministically (see mock-schema.ts's header), so
 * the set of keys this probe finds is stable across the later real call
 * `seedEntity` makes with these overrides layered on top of a fresh sample.
 */
function buildReferenceOverrides(
  entity: EntityKernelEntity,
  shortcodeByPrefix: ReadonlyMap<string, string>,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
): Record<string, unknown> {
  const schema = ENTITY_KERNEL_BINDINGS[entity].schemas.createInput;
  if (!schema) return {};
  let probe: unknown;
  try {
    probe = mock(schema, { seed: 909 });
  } catch {
    return {};
  }
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const overrides: Record<string, unknown> = {};
  const found: Array<{ path: JsonPath; code: string }> = [];
  collectShortcodePaths(probe, [], found);
  for (const { path, code } of found) {
    const prefix = prefixOf(code);
    const real = prefix ? shortcodeByPrefix.get(prefix) : undefined;
    if (real) setAtPath(overrides, path, real);
  }
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- see the walker block comment above
  return overrides;
}

interface ReferenceUniverse {
  shortcodeByPrefix: Map<string, string>;
  skippedEntities: Array<{ entity: EntityKernelEntity; reason: string }>;
}

/**
 * Seed one row of every kernel-creatable entity, in dependency order, so
 * every declared filter/sort has a real shortcode to resolve against.
 * Explicit overrides beyond the generic reference-patching above are only
 * the links the known bug instances specifically exercise (expense.trade,
 * gardenEntry -> planting) or that a create schema leaves optional and would
 * otherwise omit (task/planting/inventory/gardenEntry location and product
 * links) — everything else is discovered generically from each entity's own
 * createInput shape.
 */
async function seedReferenceUniverse(db: Database): Promise<ReferenceUniverse> {
  const shortcodeByPrefix = new Map<string, string>([
    ["LOC-", TEST_HOME_SHORTCODE],
  ]);
  const skippedEntities: Array<{ entity: EntityKernelEntity; reason: string }> =
    [];

  const record = (shortcode: string) => {
    const prefix = prefixOf(shortcode);
    if (prefix) shortcodeByPrefix.set(prefix, shortcode);
  };

  const seed = async <E extends EntityKernelEntity>(
    entity: E,
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
    extraOverrides: Record<string, unknown> = {},
  ) => {
    const skipReason = SKIPPED_ENTITIES.get(entity);
    if (skipReason) {
      skippedEntities.push({ entity, reason: skipReason });
      return null;
    }
    const overrides = {
      ...buildReferenceOverrides(entity, shortcodeByPrefix),
      ...extraOverrides,
    };
    // SAFETY: `overrides` is a sparse patch keyed by the entity's own
    // createInput shape (see buildReferenceOverrides); seedEntity/mock()
    // merges it against a freshly generated sample and re-validates through
    // the entity's real createInput schema before the kernel ever sees it.
    const created = await seedEntity(db, entity, overrides as never);
    record(created.id);
    return created;
  };

  await seed("product");
  const project = await seed("project");
  await seed("vendor");
  await seed("ingredient");
  const purchase = await seed("purchase");

  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const expenseOverrides: Record<string, unknown> = {
    trade: "drywall",
    date: "2024-01-15",
  };
  if (project) expenseOverrides.projectId = project.id;
  if (purchase) expenseOverrides.purchaseId = purchase.id;
  await seed("expense", expenseOverrides);

  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const taskOverrides: Record<string, unknown> = { trade: "drywall" };
  if (project) taskOverrides.projectId = project.id;
  await seed("task", taskOverrides);

  const planting = await seed("planting", { locationId: TEST_HOME_SHORTCODE });
  if (!planting)
    throw new Error(
      "list-smoke: planting must seed for gardenEntry.plantingId coverage",
    );
  await seed("gardenEntry", {
    plantingIds: [planting.id],
    locationId: TEST_HOME_SHORTCODE,
  });

  // Inventory cannot sit directly on the house-type root — give it a real
  // storage location underneath Home.
  const storageLocation = await seed("location", {
    parentId: TEST_HOME_SHORTCODE,
    type: "shelf",
  });
  await seed("inventory", {
    locationId: storageLocation ? storageLocation.id : TEST_HOME_SHORTCODE,
  });

  await seed("recipe");
  await seed("meal");
  await seed("wish");
  const ledgerPartyA = await seed("ledgerParty");
  const ledgerPartyB = await seed("ledgerParty");
  if (ledgerPartyB) record(ledgerPartyB.id);

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const financialAccountOverrides: Record<string, unknown> = {};
  if (ledgerPartyA) financialAccountOverrides.ledgerPartyId = ledgerPartyA.id;
  const financialAccount = await seed(
    "financialAccount",
    financialAccountOverrides,
  );

  // `financialTransactionCreateInput` cross-field-refines status/postedDate
  // and purchaseId/allocations coherence; a plain unseeded mock() sample can
  // fail those refinements outright (its own randomly-picked "posted" status
  // needs a postedDate), which makes `buildReferenceOverrides`'s probe throw
  // and silently return no overrides. Pin a combination the refinements
  // accept instead of relying on generic discovery for this one entity.
  // oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const financialTransactionOverrides: Record<string, unknown> = {
    status: "pending",
  };
  if (financialAccount)
    financialTransactionOverrides.accountId = financialAccount.id;
  await seed("financialTransaction", financialTransactionOverrides);

  await seed("productCategory");
  await seed("vendorAccount");

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- see the walker block comment above
  const ledgerTransferOverrides: Record<string, unknown> = {};
  if (ledgerPartyA) ledgerTransferOverrides.fromPartyId = ledgerPartyA.id;
  if (ledgerPartyB) ledgerTransferOverrides.toPartyId = ledgerPartyB.id;
  await seed("ledgerTransfer", ledgerTransferOverrides);

  // `image` (and any other entity this sequence never attempted) still needs
  // to be recorded as skipped for the report below.
  for (const entity of ENTITY_KERNEL_ENTITIES) {
    const reason = SKIPPED_ENTITIES.get(entity);
    if (reason && !skippedEntities.some((s) => s.entity === entity))
      skippedEntities.push({ entity, reason });
  }

  return { shortcodeByPrefix, skippedEntities };
}

function buildKernelContext(db: Database) {
  const base = createTestRequestContext(db, {
    auth: { userId: testUserId(TEST_USER_ID) },
  });
  return requireActor(base);
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

    for (const entity of ENTITY_KERNEL_ENTITIES) {
      const binding = ENTITY_KERNEL_BINDINGS[entity];
      const filterFields = filterFieldsOf(entity);

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
        await runListCase(`${entity} filter ${key}`, () =>
          executeEntity(kernelCtx, {
            action: "list",
            entity,
            filters: { [key]: sample.value },
            pagination: { pageIndex: 0, pageSize: 20 },
          }),
        );
      }

      for (const orderBy of binding.sort.fields) {
        await runListCase(`${entity} sort ${orderBy} asc`, () =>
          executeEntity(kernelCtx, {
            action: "list",
            entity,
            filters: {},
            sort: [{ orderBy, direction: "asc" }],
            pagination: { pageIndex: 0, pageSize: 20 },
          }),
        );
      }
    }

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
      `${failures.length} of ${caseCount} list case(s) threw a FROM-clause/plan error`,
    ).toBe("");
  }, 60_000); // ~640 sequential kernel/repo round trips; default 10s times out under load.
});
