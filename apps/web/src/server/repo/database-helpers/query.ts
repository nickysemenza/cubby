/**
 * Database query helper functions.
 * Search formatting, ordering, and list queries with counts.
 */

import type { PresenceFilter, SortParams } from "@cubby/schemas/pagination";
import type { AppErrorReason } from "@cubby/shared";
import type { AnyColumn, SQL, SQLWrapper } from "drizzle-orm";
import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  not,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import { match } from "ts-pattern";
import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { TraceNames, withTrace } from "~/server/tracing";

import { unwrapDb } from "./core";

/**
 * Build a combined WHERE clause from notDeleted + search terms + extra conditions.
 * Reduces the repetitive filter-building pattern across repos.
 */
export function buildSearchConditions(
  table: { deletedAt: AnyColumn },
  searchFilters: Array<{ column: AnyColumn; term: string | undefined }>,
  extraConditions?: Array<SQL | undefined>,
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [notDeleted(table)];

  for (const { column, term } of searchFilters) {
    conditions.push(formatSearchTerm(column, term));
  }

  if (extraConditions) {
    conditions.push(...extraConditions);
  }

  const defined = conditions.filter((c): c is SQL => c !== undefined);
  return defined.length > 0 ? and(...defined) : undefined;
}

/**
 * Shared server-side bounds for list-table Created / Updated filters. The upper
 * bound is exclusive midnight on the following day, so a YYYY-MM-DD selection
 * includes every timestamp on that calendar day.
 */
export function auditDateWhereConditions(
  table: { createdAt: AnyColumn; updatedAt: AnyColumn },
  filters: {
    createdFrom?: string;
    createdTo?: string;
    updatedFrom?: string;
    updatedTo?: string;
  },
): Array<SQL | undefined> {
  return [
    filters.createdFrom
      ? sql`${table.createdAt} >= ${filters.createdFrom}::date`
      : undefined,
    filters.createdTo
      ? sql`${table.createdAt} < (${filters.createdTo}::date + interval '1 day')`
      : undefined,
    filters.updatedFrom
      ? sql`${table.updatedAt} >= ${filters.updatedFrom}::date`
      : undefined,
    filters.updatedTo
      ? sql`${table.updatedAt} < (${filters.updatedTo}::date + interval '1 day')`
      : undefined,
  ];
}

/**
 * Helper function to format search terms for PostgreSQL pattern matching.
 */
export const formatSearchTerm = (
  column: AnyColumn,
  term?: string,
): SQL | undefined => {
  if (term === undefined || term.trim() === "") {
    return undefined;
  }
  return ilike(column, `%${term}%`);
};

/**
 * Helper to filter out soft-deleted records.
 * Use this in where clauses to exclude records where deletedAt is set.
 */
export const notDeleted = <T extends { deletedAt: AnyColumn }>(table: T) =>
  isNull(table.deletedAt);

/**
 * Row-level twin of {@link notDeleted}: a predicate over an already-fetched
 * record (not a SQL condition). Use this to filter soft-deleted rows in JS —
 * e.g. relations loaded in a `with` block, or join-table associations — where
 * the SQL `notDeleted()` can't apply. Keep the two in lockstep: `notDeleted`
 * filters at query time, `isNotDeleted` filters in memory. Absent (`undefined`)
 * counts as not-deleted too — `== null` matches both `null` and a missing field,
 * so partially-selected rows aren't silently dropped.
 */
export const isNotDeleted = <T extends { deletedAt?: Date | null }>(
  row: T,
): boolean => row.deletedAt == null;

/**
 * Count rows in a table matching an optional WHERE clause.
 * Wraps Drizzle's `db.$count`, which resolves directly to a number — replaces
 * the hand-rolled `select({ count: count() }).from(t).where(w)` + destructure.
 * For counts that need joins/group-by, query directly instead.
 */
export const countWhere = (
  db: Database | DrizzleTransaction,
  table: PgTable,
  where?: SQL,
): Promise<number> => unwrapDb(db).$count(table, where);

/**
 * Build ORDER BY clauses from a normalized sort stack (see `normalizeSorts`).
 *
 * When `opts.groupBy` is provided and is in `allowedFields`, prepends a primary
 * sort on that column (ASC NULLS LAST) so group members are contiguous; the
 * user's sorts order rows within each group.
 *
 * `opts.resolve` hosts a repo's special-case sorts (jsonb extractions,
 * correlated subqueries): it returns the clauses that DEFINE that field's
 * order, or null to fall through to the generic column path. Cosmetic
 * tie-breakers must NOT live in a resolver — mid-stack they would swallow any
 * subsequent user sort; pass them once via `opts.tieBreaker` instead. The
 * table's unique primary key is always appended last so offset pages cannot
 * overlap merely because the visible sort values are tied.
 */
export const buildOrderBy = <T extends PgTable & { id: AnyColumn }>(
  table: T,
  sorts: SortParams[],
  allowedFields: string[],
  opts?: {
    groupBy?: string;
    resolve?: (s: SortParams) => SQL[] | null;
    tieBreaker?: SQL;
  },
): SQL[] => {
  const clauses: SQL[] = [];
  const { groupBy, resolve, tieBreaker } = opts ?? {};

  // Prepend group-by column as primary sort (if provided, valid, and not
  // already the user's own sort)
  if (
    groupBy &&
    allowedFields.includes(groupBy) &&
    !sorts.some((s) => s.orderBy === groupBy)
  ) {
    const groupColumn = table[groupBy as keyof T] as AnyColumn | undefined;
    if (groupColumn) {
      clauses.push(sql`${groupColumn} asc nulls last`);
    }
  }

  for (const s of sorts) {
    const special = resolve?.(s);
    if (special) {
      clauses.push(...special);
      continue;
    }
    if (!allowedFields.includes(s.orderBy)) continue;
    const column = table[s.orderBy as keyof T] as AnyColumn | undefined;
    if (!column) continue;
    // ASC: nulls at end by default in Postgres
    // DESC: use NULLS LAST to put nulls at the bottom instead of the top
    // NULLS LAST in BOTH directions is the house convention (per-column
    // resolvers follow it too) — empties never surface via sort direction;
    // the relation presence ("has"/"none") filters are the way to find them.
    // Revisited and kept 2026-07.
    if (s.direction === "asc") {
      clauses.push(asc(column));
    } else {
      clauses.push(sql`${column} desc nulls last`);
    }
  }

  if (tieBreaker) clauses.push(tieBreaker);
  clauses.push(asc(table.id));
  return clauses;
};

/**
 * Executes a data query and count query in parallel and wraps results in the standard
 * paginated list response format.
 *
 * This helper consolidates the common pattern of running two queries in parallel:
 * 1. The main data query (with pagination, filtering, sorting)
 * 2. The count query (total matching records without pagination)
 *
 * Note: If you need to transform results before returning, pass the transformation
 * as part of the data query promise chain, or manually destructure and transform.
 */
export async function executeListQueryWithCount<T>(
  dataQuery: Promise<T[]>,
  countQuery: Promise<number>,
): Promise<{ data: T[]; count: number }> {
  return withTrace(TraceNames.db("listQueryWithCount"), async (span) => {
    const [data, count] = await Promise.all([dataQuery, countQuery]);
    span.setAttributes({
      "db.result_count": data.length,
      "db.total_count": count,
    });
    return { data, count };
  });
}

/**
 * Locks entity records for update and validates they exist and aren't deleted.
 * Prevents race conditions by acquiring row-level locks before safety checks.
 *
 * Use this at the start of delete operations to ensure:
 * 1. Records are locked (prevents concurrent modifications)
 * 2. All requested IDs exist and aren't already deleted
 * 3. Other transactions wait until our transaction completes
 */
export async function lockAndValidateForDelete<TId extends string>(
  tx: DrizzleTransaction,
  table: PgTable & { id: AnyColumn; deletedAt: AnyColumn },
  ids: TId[],
  entityName: string,
): Promise<void> {
  const locked = await unwrapDb(tx)
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for select()
    .select({ id: table.id as any })
    .from(table)
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle's AnyColumn type is too narrow for inArray()
    .where(and(inArray(table.id as any, ids), notDeleted(table)))
    .for("update"); // 🔒 Acquires row-level lock

  if (locked.length !== ids.length) {
    const foundIds = locked.map((e) => e.id as TId);
    const missingIds = ids.filter((id) => !foundIds.includes(id));
    throw createAppError(
      `${entityName.toUpperCase()}_NOT_FOUND` as "PRODUCT_NOT_FOUND",
      `${entityName}s not found or already deleted: ${missingIds.join(", ")}`,
    );
  }
}

/**
 * Guard a soft-delete against orphaning dependents. Given the dependent rows'
 * parent ids (the offending entities), dedupes them, refetches their names, and
 * throws a typed AppError naming them. No-op when there are no dependents. The
 * caller runs its own (entity-specific) dependent query and supplies the name
 * fetch — the shared part is the dedupe + refetch + count + join + throw.
 */
export async function assertNoDependents<TId extends string>(opts: {
  offendingParentIds: ReadonlyArray<TId | null | undefined>;
  fetchNames: (ids: TId[]) => Promise<ReadonlyArray<{ name: string }>>;
  reason: AppErrorReason;
  message: (count: number, names: string) => string;
}): Promise<void> {
  const ids = uniq(
    opts.offendingParentIds.filter((id): id is TId => id != null),
  );
  if (ids.length === 0) return;
  const offenders = await opts.fetchNames(ids);
  const names = offenders.map((o) => o.name).join(", ");
  throw createAppError(opts.reason, opts.message(offenders.length, names));
}

/**
 * Wrap a hand-written, fully-qualified SQL fragment as a typed select field,
 * bypassing Drizzle's column rewriting. The house escape hatch for a
 * **correlated scalar subquery** in a select list.
 *
 * ⚠️ **Why this exists — the `drizzle-buildSelection-strips-prefixes` trap.**
 * For a single-table `select().from(x)`, Drizzle's `buildSelection` rewrites
 * every top-level `PgColumn` chunk inside a `sql` select field to a BARE
 * identifier, stripping the table prefix. So
 * `` sql`… WHERE ${expense.purchaseId} = ${purchase.id}` `` emits
 * `WHERE "purchaseId" = "id"`, and the two ways that lands are both bad:
 *
 *  - **Silently wrong.** The bare name binds to the *subquery's* own column, so
 *    `Expense` self-joins and the field returns 0 for every row (what happened
 *    to `Purchase.expenseTotal`, and to `vendorOptions`' purchase count).
 *  - **A hard error.** When both the inner and outer table expose the name and
 *    neither wins, Postgres rejects the whole query — `/vendors` failed
 *    outright with `column reference "id" is ambiguous`.
 *
 * Nested SQL (`notDeleted(t)`, `eq()`) is not recursed into and survives, and
 * `orderBy` is not a select field at all — so the SAME expression sorts
 * correctly while the displayed value is wrong, which is what makes this so
 * easy to miss. It has produced four bugs in this repo.
 *
 * `sql.raw` has no column chunks to strip, so aliasing the inner table (`e`,
 * `v`, `se_e`) and spelling the outer reference as `"Purchase"."id"` sidesteps
 * the rewrite entirely. **The outer reference must stay FULLY qualified**: a
 * bare `"id"` would bind to the aliased inner table, which also has an `id`.
 *
 * Other sites work around the same hazard without going through this helper —
 * `repo/search.ts`, `product/quantity-ledger.ts`, `product/crud.ts`,
 * `ingredient/search.ts`, and `problems/detectors-integrity.ts` — each for its
 * own structural reason. Any new hand-qualified correlated scalar belongs here.
 */
export const correlated = <T>(fragment: string): SQL<T> =>
  sql<T>`${sql.raw(fragment)}`;

/**
 * Equality against one value or any of a set — the server half of a
 * multi-select column filter (see `oneOrMany`).
 *
 * An empty set means "no constraint", NOT "match nothing": it returns
 * undefined so the condition drops out rather than degenerating into an
 * `IN ()`, which is a syntax error. Every caller must go through here rather
 * than branching on Array.isArray itself, so that stays true everywhere.
 */
/**
 * A `uuid[]` as ONE bound parameter, for raw `sql` templates that cannot use
 * `eqAny`/`inArray` — those emit `IN ($1, …, $n)`, which is the wrong shape
 * when the whole point is to avoid a parameter per id, and they cannot target
 * an aliased table inside a hand-written UNION.
 *
 * This is the ONLY sanctioned way to write `= ANY(...)` in raw SQL, and
 * `check-conventions`' `hand-rolled-any-array` rule allows exactly this call
 * and nothing else. The trap it guards is interpolating a **JS array**, which
 * drizzle renders as a row constructor (`ANY(($1, $2))` — "op ANY/ALL requires
 * array"). What this returns is a Postgres array *literal* bound as a single
 * text value and cast in SQL, so that shape is unreachable by construction.
 *
 * Prefer it over `IN (SELECT unnest(...))`: with a bound parameter the planner
 * cannot see into the subquery and falls back to a hashed SubPlan over a full
 * table scan, where `= ANY` stays an index scan (measured on production:
 * 270 buffers against 3).
 */
export const uuidArrayParam = (ids: readonly string[]): SQL =>
  sql`${`{${[...new Set(ids)].join(",")}}`}::uuid[]`;

export const eqAny = <TColumn extends AnyColumn>(
  column: TColumn,
  value: unknown,
): SQL | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return eq(column, value);
  if (value.length === 0) return undefined;
  if (value.length === 1) return eq(column, value[0]);
  return inArray(column, value);
};

/**
 * `eqAny` for a set the caller REQUESTED but which may have resolved to nothing.
 *
 * `eqAny`'s "empty means no constraint" is right for a filter the caller left
 * empty and catastrophically wrong for one whose supplied ids all failed to
 * resolve: that must match nothing, never widen to an unfiltered query
 * (CLAUDE.md, Renderers / saved views / scopes). Pass `undefined` for "not
 * requested" and the resolved ids — empty array included — otherwise. Pairs
 * with `resolveFilterIds`, which produces exactly that shape.
 */
export const eqAnyRequested = <TColumn extends AnyColumn>(
  column: TColumn,
  ids: readonly unknown[] | undefined,
): SQL | undefined =>
  ids === undefined
    ? undefined
    : ids.length === 0
      ? sql`false`
      : eqAny(column, [...ids]);

/**
 * Equality against an optional set for a SQL expression rather than a table
 * column, such as a `jsonb_array_elements` field. This avoids binding a JS
 * array as one scalar parameter to PostgreSQL's `ANY`, while preserving the
 * optional-filter convention: an absent or empty set adds no constraint.
 */
export const matchesStringValues = (
  expression: SQL,
  values: string[] | undefined,
): SQL => {
  if (!values || values.length === 0) return sql`TRUE`;
  if (values.length === 1) return sql`${expression} = ${values[0]}`;
  return sql`${expression} IN (${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
};

/**
 * One nullable column's presence sentinel as a condition — the server half of
 * a picklist's `(none)` / `Has X` options (see `presenceFilter` in
 * `@cubby/schemas/pagination`). `undefined` presence adds no condition.
 *
 * `emptyWhen` overrides what "empty" means for a column whose empty state
 * isn't simply NULL: a `text[]` is empty when it's NULL *or* zero-length, and
 * a product has no USDA key when it has neither an fdc_id *nor* a upc. "has"
 * is always the exact negation of whatever "none" matched, derived from the
 * same predicate — so the two can never drift apart and leave a row that
 * matches neither option.
 *
 * A multi-clause `emptyWhen` is re-parenthesized here before negating, because
 * drizzle's `not()` adds no parens of its own and `NOT a AND b` binds as
 * `(NOT a) AND b` — a silent wrong answer on the "has" branch only (it cost us
 * every UPC-only product on the USDA filter). Callers that already wrap are
 * unaffected; the redundant parens are free.
 */
export const presenceCondition = (
  column: AnyColumn,
  presence: PresenceFilter,
  emptyWhen?: SQL,
): SQL | undefined =>
  match(presence)
    .with("none", () => emptyWhen ?? isNull(column))
    .with("has", () =>
      emptyWhen ? not(sql`(${emptyWhen})`) : isNotNull(column),
    )
    .with(undefined, () => undefined)
    .exhaustive();

/**
 * A cross-entity presence sentinel: "this row's id is / isn't in that set".
 *
 * `idSet` MUST be an UNCORRELATED subquery — one that references only the child
 * table, never back at the root's id. Every list repo pairs a Drizzle
 * relational-query-builder data query (which aliases the root table to its own
 * name) with an unaliased `$count`, and `productList` adds a third unaliased
 * aggregate. A correlated EXISTS resolves against different table names in each
 * of those contexts; `inArray`/`notInArray` sidestep it because the root column
 * is referenced at the WHERE's top level, where every builder rewrites it
 * correctly.
 *
 * Two things the caller owns, because SQL won't warn about either:
 * - **Soft deletes.** Guard the subquery with `notDeleted(...)` at *every* join
 *   level. `scripts/check-soft-delete-filters.mjs` only scans `exists`/
 *   `notExists` bodies, so it cannot see a hoisted `inArray` subquery.
 * - **Nullable FKs.** If the selected column is nullable, add `isNotNull(...)`
 *   to the subquery: a NULL inside a `NOT IN` list makes the whole predicate
 *   UNKNOWN, so `"none"` would match zero rows instead of every unlinked row.
 */
export const idSetPresence = <TColumn extends AnyColumn>(
  column: TColumn,
  presence: PresenceFilter,
  idSet: SQLWrapper,
): SQL | undefined =>
  match(presence)
    .with("has", () => inArray(column, idSet))
    .with("none", () => notInArray(column, idSet))
    .with(undefined, () => undefined)
    .exhaustive();

/**
 * `eqAny` OR the column's presence sentinel.
 *
 * Deliberately OR, not AND: `{value: [A], presence: "none"}` means "category A
 * *or* uncategorized" — that's what picking a value *and* `(none)` in the same
 * header filter produces, not "category A that is also null" (which no row can
 * ever satisfy; that contradiction is the bug this replaced). With no value
 * set there's nothing to OR against, so presence alone decides; with neither,
 * `or` yields `undefined` and the condition drops out.
 *
 * Every nullable picklist column should come through here rather than pairing
 * `eqAny` with a hand-written `isNull`, so the OR rule lives in one place.
 * Call `presenceCondition` directly only when the value half isn't an `eqAny`
 * — a subtree `inArray`, or `arrayOverlaps` on a tag column.
 */
export const eqAnyOrPresence = <TColumn extends AnyColumn>(
  column: TColumn,
  value: unknown,
  presence: PresenceFilter,
): SQL | undefined =>
  or(eqAny(column, value), presenceCondition(column, presence));
