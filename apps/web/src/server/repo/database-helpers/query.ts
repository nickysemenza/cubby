import {
  type InternalImpactItem,
  internalImpactItemSchema,
  type OperationDisposition,
  type OperationEffect,
} from "@cubby/schemas/entity-integrity";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { ENTITY_NOT_FOUND_REASON } from "@cubby/schemas/identifiers";
import type { PresenceFilter, SortParams } from "@cubby/schemas/pagination";
import { type AppErrorReason, parseShortcode } from "@cubby/shared";
import type { AnyColumn, SQL, SQLWrapper } from "drizzle-orm";
import {
  and,
  arrayOverlaps,
  asc,
  eq,
  getTableColumns,
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
 * Inclusive `{prefix}Min`/`{prefix}Max` numeric filter bounds against a
 * single SQL expression — a real column, or a computed one (correlated
 * subquery, jsonb extraction, COALESCE). Mirrors `auditDateWhereConditions`'s
 * shape, specialized to the one-expression min/max-pair pattern instead of
 * the fixed four created/updated date bounds.
 *
 * Only covers the plain `expr >= min` / `expr <= max` pair. A pair that
 * layers extra SQL onto the comparison (`Purchase.expenseTotalMin`'s
 * unpriced-expense guard), joins through a precomputed id set instead of
 * comparing the expression directly (`Location.directItemCountMin`'s HAVING
 * subquery), or isn't a min/max pair at all (a singleton bound with no other
 * end) is a deliberate divergence, not an oversight — leave those
 * hand-declared rather than forcing them through this helper and losing the
 * extra condition.
 */
export function rangeConditions<P extends string>(
  expr: SQL | AnyColumn,
  filters: Partial<Record<`${P}Min` | `${P}Max`, number | undefined>>,
  prefix: P,
): Array<SQL | undefined> {
  const valuesByField = new Map(Object.entries(filters));
  const min = valuesByField.get(`${prefix}Min`);
  const max = valuesByField.get(`${prefix}Max`);
  return [
    min !== undefined ? sql`${expr} >= ${min}` : undefined,
    max !== undefined ? sql`${expr} <= ${max}` : undefined,
  ];
}

export const formatSearchTerm = (
  column: AnyColumn | SQL,
  term?: string,
): SQL | undefined => {
  if (term === undefined || term.trim() === "") {
    return undefined;
  }
  return ilike(column, `%${term}%`);
};

/**
 * `formatSearchTerm` for a `text[]` column: any element matches the term.
 * `unnest` rather than `array_to_string`, so a term cannot match across the
 * boundary between two elements.
 */
export const textArrayMatches = (
  column: AnyColumn | SQL,
  term?: string,
): SQL | undefined => {
  if (term === undefined || term.trim() === "") return undefined;
  return sql`EXISTS (SELECT 1 FROM unnest(${column}) AS element WHERE element ILIKE ${`%${term}%`})`;
};

/**
 * `arrayOverlaps` OR the presence sentinel of a `text[]` column — the tag
 * filter's contract: picked values widen with `(none)` exactly as
 * `eqAnyOrPresence` does for a scalar. "Empty" is a NULL or zero-length
 * array when the column is nullable and zero-length otherwise; the outer
 * parens are load-bearing because `presenceCondition` negates the clause.
 */
export const arrayOverlapOrPresence = (
  column: AnyColumn,
  values: readonly string[] | undefined,
  presence: PresenceFilter,
  nullable: boolean,
): SQL | undefined =>
  or(
    values !== undefined && values.length > 0
      ? arrayOverlaps(column, [...values])
      : undefined,
    presenceCondition(
      column,
      presence,
      nullable
        ? sql`(${column} IS NULL OR cardinality(${column}) = 0)`
        : sql`(cardinality(${column}) = 0)`,
    ),
  );

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
  const columnsByName = new Map<string, AnyColumn>(
    Object.entries(getTableColumns(table)),
  );

  // Prepend group-by column as primary sort (if provided, valid, and not
  // already the user's own sort)
  if (
    groupBy &&
    allowedFields.includes(groupBy) &&
    !sorts.some((s) => s.orderBy === groupBy)
  ) {
    const groupColumn = columnsByName.get(groupBy);
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
    const column = columnsByName.get(s.orderBy);
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

export type ListReadIntent = "page" | "sample" | "count" | "ids";

type ListQueryPlan<T> = {
  kind: ListReadIntent;
  /** Lazy so a count read never constructs hydration SQL or starts side work. */
  rows: () => Promise<T[]>;
  count: () => Promise<number>;
};

export function executeListQueryWithCount<T>(
  plan: ListQueryPlan<T>,
): Promise<{ data: T[]; count: number }>;
export function executeListQueryWithCount<T>(
  rows: Promise<T[]>,
  count: Promise<number>,
): Promise<{ data: T[]; count: number }>;
export async function executeListQueryWithCount<T>(
  planOrRows: ListQueryPlan<T> | Promise<T[]>,
  legacyCount?: Promise<number>,
): Promise<{ data: T[]; count: number }> {
  return withTrace(TraceNames.db("listQueryWithCount"), async (span) => {
    const plan: ListQueryPlan<T> =
      "kind" in planOrRows
        ? planOrRows
        : {
            kind: "page",
            rows: () => planOrRows,
            count: () => {
              if (!legacyCount) throw new Error("Missing list count query");
              return legacyCount;
            },
          };
    const [data, count] =
      plan.kind === "count"
        ? [[], await plan.count()]
        : await Promise.all([plan.rows(), plan.count()]);
    span.setAttributes({
      "db.result_count": data.length,
      "db.total_count": count,
    });
    return { data, count };
  });
}

const LOCK_ENTITY_BY_NAME = {
  Expense: "expense",
  FinancialAccount: "financialAccount",
  FinancialTransaction: "financialTransaction",
  Ingredient: "ingredient",
  Inventory: "inventory",
  LedgerTransfer: "ledgerTransfer",
  Location: "location",
  Meal: "meal",
  Product: "product",
  Project: "project",
  Purchase: "purchase",
  Recipe: "recipe",
  Task: "task",
  Vendor: "vendor",
  Wish: "wish",
} as const satisfies Record<string, ShortcodeEntity>;

type LockEntityName = keyof typeof LOCK_ENTITY_BY_NAME;

export async function lockAndValidateForDelete<TId extends string>(
  tx: DrizzleTransaction,
  table: PgTable & { id: AnyColumn; deletedAt: AnyColumn },
  ids: TId[],
  entityName: LockEntityName,
): Promise<void> {
  const locked = await unwrapDb(tx)
    .select({ id: sql<string>`${table.id}` })
    .from(table)
    .where(and(inArray(table.id, ids), notDeleted(table)))
    .orderBy(sql`${table.id}`)
    .for("update"); // 🔒 Acquires row-level lock

  if (locked.length !== ids.length) {
    const foundIds = locked.map((entry) => String(entry.id));
    const missingIds = ids.filter((id) => !foundIds.includes(id));
    throw createAppError(
      ENTITY_NOT_FOUND_REASON[LOCK_ENTITY_BY_NAME[entityName]],
      `${entityName}s not found or already deleted: ${missingIds.join(", ")}`,
    );
  }
}

/**
 * The blocking half of {@link assertNoDependents}, as a value.
 *
 * `assertNoDependents` had the offending ids and their dependent counts, joined
 * the names into a sentence, and returned `void` — so the structure existed for
 * exactly as long as it took to stringify. The preview path had been expressing
 * the same facts as `ImpactItem`s all along; this lets the mutation path
 * produce them too, from the same inputs.
 *
 * Returns `[]` when nothing blocks, so `.length === 0` is the "may proceed"
 * check. Deliberately does NOT throw and does NOT fetch names: a caller that
 * only needs to know *whether* it is blocked should not pay for prose.
 *
 * `byTargetId` counts occurrences, so it is dependents-per-blocked-parent.
 * Note this is finer-grained than the count the legacy message renders, which
 * is the number of distinct blocked parents — see the wrapper below, which
 * preserves the old wording exactly.
 */
function dependentBlockers<TId extends string>(opts: {
  offendingParentIds: ReadonlyArray<TId | null | undefined>;
  /** The edge policy entry this blocker came from. */
  disposition: Pick<OperationDisposition, "code" | "description"> & {
    effect: OperationEffect;
  };
  /** `Table.column`, when the blocker corresponds to a declared edge. */
  edgeKey?: string;
  /** Short noun phrase naming the dependent rows — "inventory entries". */
  label: string;
}): InternalImpactItem[] {
  const present = opts.offendingParentIds.filter((id): id is TId => id != null);
  if (present.length === 0) return [];

  const byTargetId: Record<string, number> = {};
  for (const id of present) byTargetId[id] = (byTargetId[id] ?? 0) + 1;

  const itemWithoutEdge = {
    code: opts.disposition.code,
    effect: opts.disposition.effect,
    label: opts.label,
    description: opts.disposition.description,
    total: present.length,
    byTargetId,
  };
  const item = opts.edgeKey
    ? { ...itemWithoutEdge, edgeKey: opts.edgeKey }
    : itemWithoutEdge;
  return [internalImpactItemSchema.parse(item)];
}

/**
 * Guard a soft-delete against orphaning dependents.
 *
 * Genuinely built on {@link dependentBlockers}: that computes WHICH targets are
 * blocked and by how many dependents, and this adds the name fetch the prose
 * needs. Wording is unchanged — `count` is still the number of distinct blocked
 * parents, not the dependent total — so existing callers and the
 * message-asserting tests are unaffected.
 *
 * A caller that wants the structure on the wire rather than in a sentence calls
 * `dependentBlockers` directly and throws `createBlockedError` with the result;
 * `deleteFinancialAccounts` is the worked example.
 */
export async function assertNoDependents<TId extends string>(opts: {
  offendingParentIds: ReadonlyArray<TId | null | undefined>;
  fetchNames: (ids: TId[]) => Promise<ReadonlyArray<{ name: string }>>;
  reason: AppErrorReason;
  message: (count: number, names: string) => string;
}): Promise<void> {
  // One shared notion of "what is blocked", so the prose path and the
  // structured path can never disagree about it.
  const blockers = dependentBlockers({
    offendingParentIds: opts.offendingParentIds,
    disposition: {
      code: "block-dependents",
      effect: "block",
      description: "Dependent rows still reference this entity.",
    },
    label: "dependents",
  });
  if (blockers.length === 0) return;
  const ids = uniq(
    opts.offendingParentIds.filter((id): id is TId => id != null),
  );
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
 * This is the only sanctioned way to write `= ANY(...)` in raw SQL; the small
 * SQL-safety check rejects direct JS-array interpolation elsewhere. The trap is
 * interpolating a **JS array**, which
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

export const eqAny = <TColumn extends AnyColumn, TValue>(
  column: TColumn,
  value: TValue | readonly TValue[] | null | undefined,
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
 * (AGENTS.md, Renderers / saved views / scopes). Pass `undefined` for "not
 * requested" and the resolved ids — empty array included — otherwise. Pairs
 * with `resolveFilterIds`, which produces exactly that shape.
 */
export const eqAnyRequested = <TColumn extends AnyColumn, TValue>(
  column: TColumn,
  ids: readonly TValue[] | undefined,
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
 * A shortcode expression against a REQUESTED set of codes, without resolving
 * them first (usable from synchronous where-builders). Codes are compared in
 * canonical form (`parseShortcode` uppercases and remaps legacy prefixes; one
 * that does not parse is kept as-is and matches nothing). A requested set
 * that is empty matches nothing — never the whole list; `undefined` means
 * "not requested" and adds no condition.
 */
export const shortcodeSetCondition = (
  expression: SQL,
  codes: string | readonly string[] | undefined,
): SQL | undefined => {
  if (codes === undefined) return undefined;
  const canonical = [codes]
    .flat()
    .map((code) => parseShortcode(code)?.shortcode ?? code);
  if (canonical.length === 0) return sql`false`;
  return sql`${expression} IN (${sql.join(
    canonical.map((code) => sql`${code}`),
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
 *   level. The `cubby/require-soft-delete-filter` oxlint rule only scans
 *   `exists`/`notExists` bodies, so it cannot see a hoisted `inArray` subquery.
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
export const eqAnyOrPresence = <TColumn extends AnyColumn, TValue>(
  column: TColumn,
  value: TValue | readonly TValue[] | null | undefined,
  presence: PresenceFilter,
): SQL | undefined =>
  or(eqAny(column, value), presenceCondition(column, presence));
