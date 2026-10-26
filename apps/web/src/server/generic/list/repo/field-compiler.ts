/**
 * The list field compiler: one SQL expression per declared list field, so a
 * filter, a sort and a group on the same field address the same path. Own
 * columns compile in `declaredFilterPredicates`/`buildOrderBy`; this module
 * owns the `model.derived` shapes (a related `via` path, a repository value,
 * a declared predicate) and the request-scoped `prepare` step their SQL may
 * read.
 */
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type GeneratedDerivedPredicateKey,
  type GeneratedDerivedValueKey,
  type GeneratedRepositoryRowSetKey,
  type GeneratedGroupChoice,
  type GeneratedListField,
  generatedEntityListFields,
} from "@cubby/schemas/entity-list-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import type {
  ListGroupBy,
  PresenceFilter,
  SortParams,
} from "@cubby/schemas/pagination";
import { and, type AnyColumn, getTableName, SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  effectiveFieldSql,
  inheritedFieldOfColumn,
} from "~/server/db/computed/effective-field";
import { trimTextSql } from "~/server/db/computed/text-whitespace";
import { unwrapDb } from "~/server/db/helpers";
import { householdDaySql, uuidArrayParam } from "~/server/db/helpers/query";
import { createAppError } from "~/server/errors/app-error";
import type { QualityReadContext } from "~/server/generic/data-quality/repo/registry";
import { relatedSortExpression } from "~/server/generic/entity-links/repo/related-view";
import {
  hierarchyAncestorSql,
  hierarchyLevelSql,
} from "~/server/generic/list/repo/hierarchy";
import {
  compileTraversal,
  referenceColumn,
  renderJoins,
  tableFacts,
} from "~/server/generic/relatedness/repo/traversal";

/** A list request's raw filter values, by URL key. */
export const listFilterValues = z.record(z.string(), z.unknown());
export type ListFilterValues = z.output<typeof listFilterValues>;

type ListFields = typeof generatedEntityListFields;
type DerivedField = GeneratedListField;
type ViaField = Extract<DerivedField, { shape: "via" }>;
type PredicateKind = Extract<DerivedField, { shape: "predicate" }>["predicate"];

/**
 * An any-of filter's picked values and its Any value / No value key (a
 * hand-written `nullable`), ORed by the predicate.
 */
export interface AnyOfValue {
  readonly values: readonly string[];
  readonly presence: PresenceFilter;
}

/**
 * A range filter's bounds and declared presence key, or the one request
 * parameter a range whose presets expand to a named state binds (`param`).
 */
interface RangeValue {
  readonly from: string | number | undefined;
  readonly to: string | number | undefined;
  readonly presence: PresenceFilter;
  readonly param: string | number | undefined;
}

/**
 * An idMulti predicate's value, with its generated "Include sub-…" toggle
 * when the brand's entity declares `model.hierarchy` (false otherwise).
 */
interface IdMultiValue extends AnyOfValue {
  readonly includeDescendants: boolean;
}

/** The parsed filter value a declared predicate receives, by its kind. */
interface PredicateValues {
  text: string;
  multiselect: AnyOfValue;
  idMulti: IdMultiValue;
  boolean: boolean;
  presence: "has" | "none";
  range: RangeValue;
}

/**
 * One ordered part of a derived value. A part orders NULLS LAST in the
 * requested direction unless it declares otherwise: `nulls: "high"` orders
 * NULL above every value (first when descending, as Postgres does by
 * default), and `direction` fixes the part's direction whatever the request
 * (an Email link state reads newest first within each state).
 */
type DerivedPart =
  | SQL
  | {
      readonly sql: SQL;
      readonly nulls?: "high";
      readonly direction?: "asc" | "desc";
    };

/**
 * A derived value's SQL: one part, or a compound key whose parts order in
 * turn (inventory `amount` is a unit, then a size). A compound value sorts
 * and groups but cannot filter.
 */
type DerivedValue = DerivedPart | readonly [DerivedPart, ...DerivedPart[]];

/**
 * Request data a derived field's SQL reads (inventory valuations run WASM
 * over every row; an Email list's link state is relative to its scope
 * filter). Created once per repository; several fields share one by passing
 * the same handle, and `hydrate` reads its result from the context.
 */
type PrepareLoad<P> = (
  db: Database | DrizzleTransaction,
  filters: ListFilterValues,
) => Promise<P>;

export interface ListPrepare<P> {
  readonly loadShared?: (
    scope: ListPreparationScope,
    db: Database | DrizzleTransaction,
  ) => Promise<P>;
  readonly load: PrepareLoad<P>;
  value(render: (prepared: P) => DerivedValue): PreparedValue;
  predicate<V>(
    render: (prepared: P, value: V) => SQL | undefined,
  ): PreparedPredicate<V>;
  rows(render: (prepared: P) => SQL): PreparedRows;
}

interface PreparedRows {
  readonly prepare: ListPrepare<unknown>;
  readonly render: (context: ListContext) => SQL;
}

interface PreparedValue {
  readonly prepare: ListPrepare<unknown>;
  readonly render: (context: ListContext) => DerivedValue;
}

interface PreparedPredicate<V> {
  readonly prepare: ListPrepare<unknown>;
  readonly render: (context: ListContext, value: V) => SQL | undefined;
}

/**
 * A derived value whose SQL reads the caller's quality read context (a
 * Problem or work-queue read that already materialized on-hand units).
 * Absent, it renders the canonical scalar.
 */
interface ReadValue {
  readonly read: (read: QualityReadContext | undefined) => DerivedValue;
}

export const listReadValue = (
  read: (read: QualityReadContext | undefined) => DerivedValue,
): ReadValue => ({ read });

/**
 * A value whose filters read a whole-list relation instead of the per-row
 * scalar: `set` selects `("id", "value")` for every row that has one, and a
 * filter matches `id IN (SELECT "id" FROM set WHERE …)`, so one set-based
 * walk serves the filter. Sort, group and projection read `value`, which must
 * agree with `set` row for row.
 */
interface SetValue {
  readonly value: SQL;
  readonly set: SQL;
}

const createListPrepare = <P>(
  load: PrepareLoad<P>,
  loadShared?: ListPrepare<P>["loadShared"],
): ListPrepare<P> => {
  const handle: ListPrepare<P> = {
    load,
    loadShared,
    value: (render) => ({
      prepare: handle,
      render: (context) => render(context.get(handle)),
    }),
    predicate: (render) => ({
      prepare: handle,
      render: (context, value) => {
        // A filter-dependent load ran over the include values, so its data
        // cannot answer the excluded values a negated predicate is given.
        if (context.excluded && loadShared === undefined)
          throw new Error(
            "An Exclude filter rendered a predicate over listPrepare data loaded from the request filters; load it with sharedListPrepare and select by the values the predicate receives.",
          );
        return render(context.get(handle), value);
      },
    }),
    rows: (render) => ({
      prepare: handle,
      render: (context) => render(context.get(handle)),
    }),
  };
  return handle;
};

export const listPrepare = <P>(load: PrepareLoad<P>): ListPrepare<P> =>
  createListPrepare(load);

/** Only filter-independent inputs may be shared by sibling list reads. */
export const sharedListPrepare = <P>(
  load: (db: Database | DrizzleTransaction) => Promise<P>,
): ListPrepare<P> => {
  const pending = new WeakMap<ListPreparationScope, Promise<P>>();
  return createListPrepare(load, (scope, db) => {
    const existing = pending.get(scope);
    if (existing) return existing;
    const promise = Promise.resolve().then(() => load(db));
    pending.set(scope, promise);
    return promise;
  });
};

/** One read operation, one database identity; never retained across writes. */
export class ListPreparationScope {
  constructor(private readonly db: Database | DrizzleTransaction) {}

  load<P>(
    prepare: ListPrepare<P>,
    db: Database | DrizzleTransaction,
    filters: ListFilterValues,
  ): Promise<P> {
    if (db !== this.db) throw new Error("List preparation database changed");
    return prepare.loadShared
      ? prepare.loadShared(this, db)
      : prepare.load(db, filters);
  }
}

/**
 * The prepared data of one list request, loaded by `scaffold.context`, and
 * the quality read context its caller passed to `where`. `excluded` marks the
 * include predicates an Exclude key negates.
 */
export class ListContext {
  constructor(
    private readonly prepared: ReadonlyMap<ListPrepare<unknown>, unknown>,
    readonly read?: QualityReadContext,
    readonly excluded = false,
  ) {}

  static readonly empty = new ListContext(new Map());

  withRead(read: QualityReadContext | undefined): ListContext {
    return read === this.read
      ? this
      : new ListContext(this.prepared, read, this.excluded);
  }

  /** This context plus a related scope's nested one (distinct handles). */
  with(nested: ListContext): ListContext {
    return nested.prepared.size === 0
      ? this
      : new ListContext(
          new Map([...this.prepared, ...nested.prepared]),
          this.read,
          this.excluded,
        );
  }

  excluding(): ListContext {
    return new ListContext(this.prepared, this.read, true);
  }

  /** The loaded prepares, to seed a fuller context without reloading them. */
  entries(): Array<readonly [ListPrepare<unknown>, unknown]> {
    return [...this.prepared];
  }

  has(prepare: ListPrepare<unknown>): boolean {
    return this.prepared.has(prepare);
  }

  get<P>(prepare: ListPrepare<P>): P {
    if (!this.prepared.has(prepare))
      throw new Error(
        "A derived list field read data its request did not prepare; build the context from the same request.",
      );
    // SAFETY: `scaffold.context` stores each handle's own `load` result.
    return this.prepared.get(prepare) as P;
  }
}

type DerivedValueSql = DerivedValue | PreparedValue | ReadValue | SetValue;
type DerivedPredicateSql<V> =
  | ((value: V, read: QualityReadContext | undefined) => SQL | undefined)
  | PreparedPredicate<V>;

type PredicateValueOf<E extends Entity, K extends string> =
  ListFields[E]["derived"] extends Record<
    K,
    { shape: "predicate"; predicate: infer Kind extends PredicateKind }
  >
    ? PredicateValues[Kind]
    : never;

/**
 * The SQL a repository owes `listScaffold` for its declared derived fields:
 * generated from the declaration, so a `type` or `predicate` key without SQL
 * fails typecheck.
 */
export type DerivedSqlArg<E extends Entity> = {
  readonly [K in GeneratedDerivedValueKey<E>]: DerivedValueSql;
} & {
  readonly [K in GeneratedDerivedPredicateKey<E>]: DerivedPredicateSql<
    PredicateValueOf<E, K>
  >;
};

export type AnyDerivedSql = Readonly<
  Record<string, DerivedValueSql | DerivedPredicateSql<never>>
>;

export const derivedFieldsOf = (
  entity: Entity,
): Readonly<Record<string, DerivedField>> =>
  generatedEntityListFields[entity].derived;

const isPrepared = (
  entry: DerivedValueSql | DerivedPredicateSql<never>,
): entry is PreparedValue | PreparedPredicate<never> =>
  typeof entry === "object" && "prepare" in entry;
const isReadValue = (
  entry: DerivedValueSql | DerivedPredicateSql<never>,
): entry is ReadValue => typeof entry === "object" && "read" in entry;
const isSetValue = (
  entry: DerivedValueSql | DerivedPredicateSql<never>,
): entry is SetValue => typeof entry === "object" && "set" in entry;

/** The prepare a derived field's SQL needs, if any. */
export const derivedPrepare = (
  derived: AnyDerivedSql,
  key: string,
): ListPrepare<unknown> | null => {
  const entry = derived[key];
  return entry !== undefined && isPrepared(entry) ? entry.prepare : null;
};

const missingSql = (entity: Entity, key: string) =>
  new Error(
    `${entity}.model.derived.${key} has no SQL; pass it in listScaffold's derived argument`,
  );

/** A derived value field's SQL in `context`, one part per compound key part. */
const derivedValueParts = (
  entity: Entity,
  derived: AnyDerivedSql,
  key: string,
  context: ListContext,
): readonly DerivedPart[] => {
  const entry = derived[key];
  if (entry === undefined || typeof entry === "function")
    throw missingSql(entity, key);
  // SAFETY: `DerivedSqlArg` gives a value key only a value, a prepared,
  // read or set value, never a predicate's function or prepared predicate.
  const value = isPrepared(entry)
    ? (entry as PreparedValue).render(context)
    : isReadValue(entry)
      ? entry.read(context.read)
      : isSetValue(entry)
        ? entry.value
        : (entry as DerivedValue);
  return isCompound(value) ? value : [value];
};

// `Array.isArray` does not narrow a readonly tuple out of a union.
const isCompound = (
  value: DerivedValue,
): value is readonly [DerivedPart, ...DerivedPart[]] => Array.isArray(value);

/** A derived value field's single SQL expression in `context`. */
export const derivedValueSql = (
  entity: Entity,
  derived: AnyDerivedSql,
  key: string,
  context: ListContext,
): SQL => {
  const [value, ...rest] = derivedValueParts(entity, derived, key, context);
  if (value === undefined || rest.length > 0)
    throw new Error(
      `${entity}.model.derived.${key} is a compound sort key and cannot filter`,
    );
  return value instanceof SQL ? value : value.sql;
};

/**
 * A `dateInterval` value's `[start, end]` in `context`; a NULL end is open.
 * Range filters test it for overlap, a one-date filter for containment.
 */
export const derivedIntervalSql = (
  entity: Entity,
  derived: AnyDerivedSql,
  key: string,
  context: ListContext,
) => {
  const parts = derivedValueParts(entity, derived, key, context);
  const [start, end] = parts.map((part) =>
    part instanceof SQL ? part : part.sql,
  );
  if (start === undefined || end === undefined || parts.length !== 2)
    throw new Error(
      `${entity}.model.derived.${key} is a dateInterval and needs its SQL as [start, end]`,
    );
  return { start, end };
};

/** A value's filter relation (`SetValue`), or null when filters read its scalar. */
export const derivedValueSet = (
  derived: AnyDerivedSql,
  key: string,
): SQL | null => {
  const entry = derived[key];
  return entry !== undefined && isSetValue(entry) ? entry.set : null;
};

/** A declared predicate's condition for a parsed filter value. */
export const derivedPredicateSql = <V>(
  entity: Entity,
  derived: AnyDerivedSql,
  key: string,
  context: ListContext,
  value: V,
): SQL | undefined => {
  const entry = derived[key];
  if (entry === undefined) throw missingSql(entity, key);
  if (typeof entry === "function")
    // SAFETY: `DerivedSqlArg` types each predicate by its declared kind, and
    // the caller parsed `value` by that same kind.
    return (
      entry as (
        value: V,
        read: QualityReadContext | undefined,
      ) => SQL | undefined
    )(value, context.read);
  if (isPrepared(entry))
    // SAFETY: as above; a predicate key's prepared entry renders that kind.
    return (entry as PreparedPredicate<V>).render(context, value);
  throw missingSql(entity, key);
};

const viaParts = (entity: Entity, field: ViaField) => {
  const traversal = compileTraversal(entity, field.steps, "lf", {
    to: field.target,
  });
  const leaf = sql.raw(traversal.leafAlias);
  return {
    from: sql`${sql.identifier(traversal.rootTable)} ${sql.raw(traversal.rootAlias)} ${traversal.joins}`,
    root: sql.raw(traversal.rootAlias),
    leaf,
    leafAlias: traversal.leafAlias,
    leafTable: traversal.leafTable,
  };
};

/**
 * A terminal column of a related record: its effective value when the field
 * it stores is inherited (`resolution.inherit`), else the column.
 */
const terminalSql = (target: Entity, leaf: string, column: string): SQL => {
  const inherited = inheritedFieldOfColumn(target, column);
  return inherited === null
    ? sql`${sql.raw(leaf)}.${sql.identifier(column)}`
    : effectiveFieldSql(target, inherited, leaf);
};

/**
 * One column of the record a to-one path leads to. The path starts at the
 * outer row itself, so the subquery probes only the related tables rather
 * than re-reading the root by id.
 */
const relatedColumnSql = (
  entity: Entity,
  path: Readonly<Pick<ViaField, "steps" | "target">>,
  table: PgTable,
  column: string,
): SQL => {
  const traversal = compileTraversal(entity, path.steps, "lf", {
    to: path.target,
    root: `"${getTableName(table)}"`,
  });
  const [first, ...rest] = traversal.hops;
  if (first === undefined)
    throw new Error(`${entity} → ${path.target} has no relation step`);
  const firstAlias = sql.raw(first.alias);
  return sql`(SELECT ${terminalSql(path.target, traversal.leafAlias, column)} FROM ${sql.identifier(first.relation ?? first.table)} ${firstAlias} ${renderJoins({ hops: rest })} WHERE (${first.condition})${
    first.softDelete ? sql` AND ${firstAlias}."deletedAt" IS NULL` : sql``
  })`;
};

type Rollup = NonNullable<Extract<DerivedField, { shape: "value" }>["rollup"]>;

/**
 * A declared `rollup`: the aggregate of the live rows a relation path leads
 * to from the outer row of `table`. Each hop is live, like every `via`.
 */
const rollupSql = (entity: Entity, rollup: Rollup, table: PgTable): SQL => {
  const traversal = compileTraversal(entity, rollup.steps, "ru", {
    to: rollup.target,
    root: `"${getTableName(table)}"`,
  });
  const [first, ...rest] = traversal.hops;
  if (first === undefined)
    throw new Error(`${entity} rollup ${rollup.path} has no relation step`);
  const leaf = (column: string) =>
    sql`${sql.raw(traversal.leafAlias)}.${sql.identifier(column)}`;
  const value = rollup.column === null ? null : leaf(rollup.column);
  const aggregate =
    rollup.aggregate === "count"
      ? sql`count(*)::int`
      : rollup.aggregate === "sum"
        ? // Accumulate exactly; summing double precision drifts by cents.
          sql`COALESCE(sum(${value}::numeric), 0)::double precision`
        : sql`${sql.raw(rollup.aggregate)}(${value})`;
  const firstAlias = sql.raw(first.alias);
  const conditions = [
    sql`(${first.condition})`,
    ...(first.softDelete ? [sql`${firstAlias}."deletedAt" IS NULL`] : []),
    ...rollup.absent.map((column) => sql`${leaf(column)} IS NULL`),
  ];
  const joins = rest.length ? sql` ${renderJoins({ hops: rest })}` : sql``;
  return sql`(SELECT ${aggregate} FROM ${sql.identifier(first.relation ?? first.table)} ${firstAlias}${joins} WHERE ${sql.join(conditions, sql` AND `)})`;
};

/** One declared rollup, for a repository column that shows the same value. */
export const declaredRollup = <T = number>(
  entity: Entity,
  key: string,
  table: PgTable,
): SQL<T> => {
  const field = derivedFieldsOf(entity)[key];
  if (field?.shape !== "value" || !field.rollup)
    throw new Error(`${entity}.model.derived.${key} is not a declared rollup`);
  return sql<T>`${rollupSql(entity, field.rollup, table)}`;
};

/** A rollup's value: a count or sum, a date extreme, or NULL. */
const rollupValue = z.union([z.number(), z.string(), z.null()]);
type RollupValue = z.output<typeof rollupValue>;
const rollupRow = z.object({ id: z.string() }).catchall(rollupValue);

/**
 * The batched form of declared rollups: `keys` for every record in `ids`,
 * in one statement, keyed by record id. Detail reads, quality loaders and
 * other non-list readers use it instead of a statement per record.
 */

export const loadDeclaredRollups = async (
  db: Database | DrizzleTransaction,
  entity: Entity,
  table: PgTable & { id: AnyColumn },
  ids: readonly string[],
  keys: readonly string[],
): Promise<Map<string, ReadonlyMap<string, RollupValue>>> => {
  if (ids.length === 0 || keys.length === 0) return new Map();
  const id = sql`${sql.identifier(getTableName(table))}.${sql.identifier(table.id.name)}`;
  const rows = await unwrapDb(db).execute(
    sql`SELECT ${id} AS id, ${sql.join(
      keys.map(
        (key) =>
          sql`${declaredRollup(entity, key, table)} AS ${sql.identifier(key)}`,
      ),
      sql`, `,
    )} FROM ${table} WHERE ${id} = ANY(${uuidArrayParam(ids)})`,
  );
  return new Map(
    rows.rows.map((raw) => {
      const { id: rowId, ...values } = rollupRow.parse(raw);
      return [rowId, new Map(Object.entries(values))];
    }),
  );
};

/** Every declared rollup of `entity`, as SQL correlated to `table`. */
export const declaredRollups = (
  entity: Entity,
  table: PgTable,
): Readonly<Record<string, SQL>> =>
  Object.fromEntries(
    Object.entries(derivedFieldsOf(entity)).flatMap(([key, field]) =>
      field.shape === "value" && field.rollup
        ? [[key, rollupSql(entity, field.rollup, table)]]
        : [],
    ),
  );

/** The scalar a to-one `via` path reads: the terminal field or record title. */
const relatedScalarSql = (
  entity: Entity,
  field: ViaField,
  table: PgTable,
): SQL => {
  if (field.sort !== null)
    throw createAppError("CONSTRAINT_VIOLATION", field.sort);
  const column =
    field.terminal.kind === "field"
      ? field.terminal.column
      : field.terminal.titleColumn;
  if (column === null)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${entity}.${field.path} has no stored title`,
    );
  return relatedColumnSql(entity, field, table, column);
};

/** `EXISTS` over a `via` path (any cardinality) whose terminal row matches. */
export const relatedExistsSql = (
  entity: Entity,
  field: ViaField,
  outerId: AnyColumn,
  matches: (leaf: SQL, column: SQL) => SQL | undefined,
): SQL | undefined => {
  const { from, root, leaf, leafAlias } = viaParts(entity, field);
  const column = terminalSql(
    field.target,
    leafAlias,
    field.terminal.kind === "field"
      ? field.terminal.column
      : (field.terminal.titleColumn ?? "id"),
  );
  const condition = matches(leaf, column);
  if (condition === undefined) return undefined;
  return sql`EXISTS (SELECT 1 FROM ${from} WHERE ${root}."id" = ${outerId} AND ${condition})`;
};

type RowsField = Extract<DerivedField, { shape: "rows" }>;

/**
 * One declared row set (`model.rows`) of the list's outer row:
 * `matches(condition)` holds when one row of the set matches `condition`, so
 * every condition passed together holds on the same row; `empty()` when the
 * record has no row; and `column` is the SQL of a terminal on that row (a
 * column, a JSON item key, or the id of a referenced record).
 */
export interface RowSetSql {
  readonly matches: (condition: SQL | undefined) => SQL;
  /** A row matches `condition`, or the record has no row at all. */
  readonly matchesOrEmpty: (condition: SQL | undefined) => SQL;
  readonly column: (field: RowsField) => SQL;
}

/**
 * A repository row set's relation: SQL selecting `"owner"` and its declared
 * columns, or one rendered from a `listPrepare` (`prepare.rows`).
 */
type RowsSql = SQL | PreparedRows;

/** The relations a repository owes `listScaffold` for its repository row sets. */
export type RowsSqlArg<E extends Entity> = {
  readonly [K in GeneratedRepositoryRowSetKey<E>]: RowsSql;
};

export type AnyRowsSql = Readonly<Record<string, RowsSql>>;

/** The prepare a repository row set's relation needs, if any. */
export const rowsPrepare = (
  rows: AnyRowsSql,
  key: string,
): ListPrepare<unknown> | null => {
  const entry = rows[key];
  return entry !== undefined && !(entry instanceof SQL) ? entry.prepare : null;
};

export const rowSetSql = (
  entity: Entity,
  key: string,
  /** The list's outer table, which the set belongs to. */
  outerTable: string,
  rows: AnyRowsSql = {},
  context: ListContext = ListContext.empty,
): RowSetSql => {
  const rowSet = Object.entries(generatedEntityListFields[entity].rows).find(
    ([name]) => name === key,
  )?.[1];
  if (rowSet === undefined)
    throw new Error(`${entity} declares no model.rows ${key}`);
  const outer = sql.identifier(outerTable);
  const { storage } = rowSet;
  const correlated = (exists: (condition: SQL | undefined) => SQL) => ({
    matches: exists,
    matchesOrEmpty: (condition: SQL | undefined) =>
      sql`(${exists(condition)} OR NOT ${exists(undefined)})`,
  });
  if (storage.kind === "repository") {
    // Rendered only when a filter reads the set, so its prepare need not run
    // otherwise.
    const relation = () => {
      const entry = rows[key];
      if (entry === undefined)
        throw new Error(
          `${entity}.model.rows.${key} has no SQL; pass it in listScaffold's rows argument`,
        );
      return entry instanceof SQL ? entry : entry.render(context);
    };
    // Uncorrelated, so the relation is computed once for the whole list.
    return {
      matches: (condition) =>
        sql`${outer}."id" IN (SELECT row_set."owner" FROM (${relation()}) row_set WHERE ${condition ?? sql`true`})`,
      // One pass: drop exactly the owners with rows of which none matches.
      matchesOrEmpty: (condition) =>
        sql`${outer}."id" NOT IN (SELECT row_set."owner" FROM (${relation()}) row_set
          GROUP BY row_set."owner" HAVING NOT bool_or(COALESCE(${condition ?? sql`true`}, false)))`,
      column: (field) =>
        sql`row_set.${sql.identifier(
          field.terminal.kind === "column"
            ? field.terminal.column
            : field.path.slice(key.length + 1),
        )}`,
    };
  }
  if (storage.kind === "json") {
    const array = sql`${outer}.${sql.identifier(storage.column)}`;
    const from = sql`jsonb_array_elements(CASE WHEN jsonb_typeof(${array}) = 'array' THEN ${array} ELSE '[]'::jsonb END) row_set`;
    return {
      ...correlated(
        (condition) =>
          sql`EXISTS (SELECT 1 FROM ${from} WHERE ${condition ?? sql`true`})`,
      ),
      column: (field) => {
        if (field.terminal.kind !== "column")
          throw new Error(`${entity}.${field.path} reads a JSON row's record`);
        return sql`(row_set->>${field.terminal.column})`;
      },
    };
  }
  const traversal = compileTraversal(entity, storage.steps, "rs", {
    root: `"${outerTable}"`,
  });
  const [first, ...rest] = traversal.hops;
  if (first === undefined) throw new Error(`${entity}.rows.${key} has no step`);
  const facts = tableFacts(traversal.leafTable);
  const leaf = (column: string) => {
    if (!facts.columns.has(column))
      throw new Error(
        `${entity}.rows.${key}: ${traversal.leafTable} has no column ${column}`,
      );
    return sql`${sql.raw(traversal.leafAlias)}.${sql.identifier(column)}`;
  };
  const firstAlias = sql.raw(first.alias);
  const where = and(
    first.condition,
    first.softDelete ? sql`${firstAlias}."deletedAt" IS NULL` : undefined,
    ...Object.entries(storage.kind === "path" ? storage.where : {}).map(
      ([column, value]) => sql`${leaf(column)} = ${value}`,
    ),
  );
  return {
    ...correlated(
      (condition) =>
        sql`EXISTS (SELECT 1 FROM ${sql.identifier(first.relation ?? first.table)} ${firstAlias} ${renderJoins({ hops: rest })} WHERE ${and(where, condition)})`,
    ),
    column: (field) => {
      const column =
        field.terminal.kind === "column"
          ? field.terminal.column
          : (field.terminal.column ??
            referenceColumn(traversal.leafTable, field.terminal.target));
      const raw = leaf(column);
      // A relation's entity field that inherits filters by its effective value.
      return storage.kind === "relation"
        ? terminalSql(storage.target, traversal.leafAlias, column)
        : raw;
    },
  };
};

/**
 * The id subquery of the requested public shortcodes of live `target` rows,
 * resolved inside the list query (#2333): an unknown or soft-deleted code
 * matches nothing.
 */
export const shortcodeIdsSql = (
  target: Entity,
  condition: (shortcode: SQL) => SQL | undefined,
): SQL => {
  const { dbTable, softDelete } = entityManifest[target];
  if (dbTable === null) throw new Error(`${target} has no table to filter by`);
  return sql`(SELECT ref."id" FROM ${sql.identifier(dbTable)} ref WHERE ${
    condition(sql`ref."shortcode"`) ?? sql`false`
  }${softDelete ? sql` AND ref."deletedAt" IS NULL` : sql``})`;
};

/**
 * The ORDER BY of a declared derived field or a `related:<view>` roster
 * column, or null for a field this compiler does not own. A rejected field (a
 * to-many path, a filter-only predicate) fails with the reason the
 * declaration derives. A part orders NULLS LAST in both directions, the
 * convention `buildOrderBy` applies to stored columns, unless it declares
 * its own placement or direction (`DerivedPart`).
 */
export const derivedOrderBy = (
  entity: Entity,
  derived: AnyDerivedSql,
  sort: SortParams,
  table: PgTable,
  context: ListContext,
): SQL[] | null => {
  const order = (parts: readonly DerivedPart[]) =>
    parts.map((part) => {
      const {
        sql: value,
        nulls,
        direction = sort.direction,
      } = part instanceof SQL ? { sql: part } : part;
      const placement =
        nulls === "high" && direction === "desc" ? "first" : "last";
      return sql`${value} ${sql.raw(direction === "asc" ? "asc" : "desc")} nulls ${sql.raw(placement)}`;
    });
  if (sort.orderBy.startsWith("related:"))
    return order([
      relatedSortExpression(
        entity,
        sort.orderBy.slice("related:".length),
        `"${getTableName(table)}"."id"`,
      ),
    ]);
  const field = derivedFieldsOf(entity)[sort.orderBy];
  if (field === undefined) return null;
  switch (field.shape) {
    case "via":
      return order([relatedScalarSql(entity, field, table)]);
    case "value":
      return order(derivedValueParts(entity, derived, sort.orderBy, context));
    case "rows":
    case "predicate":
      throw createAppError("CONSTRAINT_VIOLATION", field.sort);
  }
};

/**
 * A group's SQL: the section key (null for the no-value section), its label
 * when the key is not already readable (a related record's title), and the
 * order that ranks sections. Each `order` part ascends with NULLS LAST, so
 * the no-value section is always last; `"key"`/`"label"` stand for those
 * expressions, letting the summary query order by its selected columns.
 * `subtree`, on a level-grouped hierarchy, is true for a row grouped under
 * an ancestor rather than its own value.
 */
export interface ListGroupSql {
  readonly choice: GeneratedGroupChoice;
  readonly key: SQL;
  readonly label: SQL | null;
  readonly order: readonly (SQL | "key" | "label")[];
  readonly subtree: SQL | null;
  /** Correlated SQL expansion; the caller LEFT JOINs it once per dimension. */
  readonly members?: SQL;
}

const optionOrder = (
  value: SQL,
  options: readonly { readonly value: string }[] | null,
): readonly (SQL | "key")[] =>
  options === null
    ? ["key"]
    : [
        sql`array_position(ARRAY[${sql.join(
          options.map((option) => sql`${option.value}`),
          sql`, `,
        )}]::text[], ${value})`,
        "key",
      ];

/**
 * Compiles a `model.grouping` choice for `table`. A choice the declaration
 * cannot group by fails with its derived reason, unmasked. At a `level`, a
 * related record groups under its ancestor at that level (itself when it
 * sits above it), so a section counts its key's descendants.
 */
export const groupSql = (
  entity: Entity,
  { key, level, bucket }: ListGroupBy,
  derived: AnyDerivedSql,
  table: PgTable,
  context: ListContext,
): ListGroupSql => {
  const choices: readonly GeneratedGroupChoice[] =
    generatedEntityListFields[entity].grouping;
  const choice = choices.find((candidate) => candidate.key === key);
  if (choice === undefined)
    throw createAppError(
      "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      `${entity} declares no Group by choice ${key}`,
    );
  if (choice.value === null)
    throw createAppError(
      "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      choice.reason ?? `Cannot group ${entity} by "${key}"`,
    );
  if (bucket !== undefined && !choice.buckets.includes(bucket))
    throw createAppError(
      "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      `${choice.label} does not support ${bucket} buckets`,
    );
  const value = choice.value;
  if (level !== undefined && (value.kind !== "record" || level > choice.levels))
    throw createAppError(
      "LIST_GROUP_BY_FIELD_UNSUPPORTED",
      choice.levelReason ??
        `${choice.label} offers levels 1–${choice.levels}, not ${level}`,
    );
  switch (value.kind) {
    case "record": {
      if (choice.multiple) {
        const traversal = compileTraversal(entity, value.steps, "lg", {
          to: value.target,
          root: `"${getTableName(table)}"`,
        });
        const [first, ...rest] = traversal.hops;
        if (first === undefined)
          throw new Error(`${entity}.${key} has no relation step`);
        const leafId = sql`${sql.raw(traversal.leafAlias)}."id"`;
        const id =
          level === undefined
            ? leafId
            : hierarchyAncestorSql(value.target, leafId, level);
        const dbTable = entityManifest[value.target].dbTable;
        if (dbTable === null) throw new Error(`${value.target} has no table`);
        const at = (column: string) =>
          level === undefined
            ? sql`${sql.raw(traversal.leafAlias)}.${sql.identifier(column)}`
            : sql`(SELECT a.${sql.identifier(column)} FROM ${sql.identifier(dbTable)} a WHERE a."id" = ${id})`;
        return {
          choice,
          key: sql`null::text`,
          label: sql`null::text`,
          order: ["label", "key"],
          subtree: null,
          members: sql`SELECT DISTINCT ${at("shortcode")}::text AS "key", ${at(value.titleColumn)}::text AS "label", ${level === undefined ? sql`false` : sql`${hierarchyLevelSql(value.target, leafId)} > ${level}::int`} AS "subtree" FROM ${sql.identifier(first.relation ?? first.table)} ${sql.raw(first.alias)} ${renderJoins({ hops: rest })} WHERE (${first.condition})${first.softDelete ? sql` AND ${sql.raw(first.alias)}."deletedAt" IS NULL` : sql``}`,
        };
      }
      if (level === undefined)
        return {
          choice,
          key: relatedColumnSql(entity, value, table, "shortcode"),
          label: relatedColumnSql(entity, value, table, value.titleColumn),
          order: ["label", "key"],
          subtree: null,
        };
      const id = relatedColumnSql(entity, value, table, "id");
      const ancestor = hierarchyAncestorSql(value.target, id, level);
      const { dbTable } = entityManifest[value.target];
      if (dbTable === null)
        throw new Error(`${value.target} has no table to group by`);
      const column = (name: string) =>
        sql`(SELECT a.${sql.identifier(name)} FROM ${sql.identifier(dbTable)} a WHERE a."id" = ${ancestor})`;
      return {
        choice,
        key: column("shortcode"),
        label: column(value.titleColumn),
        order: ["label", "key"],
        subtree: sql`${hierarchyLevelSql(value.target, id)} > ${level}::int`,
      };
    }
    case "column":
    case "field":
    case "derived": {
      if (value.kind === "field" && choice.multiple) {
        const traversal = compileTraversal(entity, value.steps, "lg", {
          to: value.target,
          root: `"${getTableName(table)}"`,
        });
        const [first, ...rest] = traversal.hops;
        if (first === undefined)
          throw new Error(`${entity}.${key} has no relation step`);
        const raw = terminalSql(
          value.target,
          traversal.leafAlias,
          value.column,
        );
        const array = entityFieldModels[value.target].storage.some(
          (column) =>
            column.column === value.column && column.kind === "text-array",
        );
        const leaf = array ? sql`group_value` : raw;
        const day =
          choice.dateKind === "timestamp"
            ? householdDaySql(leaf)
            : sql`${leaf}::date`;
        const text =
          choice.dateKind === null
            ? sql`NULLIF(${trimTextSql(sql`${leaf}::text`)}, '')`
            : sql`date_trunc(${bucket ?? "day"}::text, ${day}::timestamp)::date::text`;
        return {
          choice,
          key: sql`null::text`,
          label: null,
          order: ["key"],
          subtree: null,
          members: sql`SELECT DISTINCT ${text} AS "key", null::text AS "label", false AS "subtree" FROM ${sql.identifier(first.relation ?? first.table)} ${sql.raw(first.alias)} ${renderJoins({ hops: rest })}${array ? sql` CROSS JOIN LATERAL unnest(${raw}) group_value` : sql``} WHERE (${first.condition})${first.softDelete ? sql` AND ${sql.raw(first.alias)}."deletedAt" IS NULL` : sql``} AND ${text} IS NOT NULL`,
        };
      }
      const raw =
        value.kind === "column"
          ? terminalSql(entity, `"${getTableName(table)}"`, value.column)
          : value.kind === "field"
            ? relatedColumnSql(entity, value, table, value.column)
            : derivedValueSql(entity, derived, key, context);
      if (choice.multiple)
        return {
          choice,
          key: sql`null::text`,
          label: null,
          order: ["key"],
          subtree: null,
          members: sql`SELECT DISTINCT NULLIF(${trimTextSql(sql`v::text`)}, '') AS "key", null::text AS "label", false AS "subtree" FROM unnest(${raw}) AS v WHERE NULLIF(${trimTextSql(sql`v::text`)}, '') IS NOT NULL`,
        };
      if (choice.dateKind !== null) {
        const day =
          choice.dateKind === "timestamp"
            ? householdDaySql(raw)
            : sql`${raw}::date`;
        const date = sql`date_trunc(${bucket ?? "day"}::text, ${day}::timestamp)::date::text`;
        return {
          choice,
          key: date,
          label: null,
          order: ["key"],
          subtree: null,
        };
      }
      // Blank text reads as no value, like an absent one.
      const text = sql`NULLIF(${trimTextSql(sql`${raw}::text`)}, '')`;
      return {
        choice,
        key: text,
        label: null,
        order: optionOrder(text, value.options),
        subtree: null,
      };
    }
  }
};

/** Only explicitly admitted scalar numeric fields can contribute a metric. */
export const listMetricSql = (
  entity: Entity,
  key: string,
  derived: AnyDerivedSql,
  table: PgTable,
  context: ListContext,
): SQL => {
  const fields: Readonly<Record<string, GeneratedListField>> =
    generatedEntityListFields[entity].derived;
  const value = fields[key];
  if (value?.shape === "value" && value.type === "number")
    return derivedValueSql(entity, derived, key, context);
  const model = entityFieldModels[entity];
  const field = model.fields.find((field) => field.key === key);
  const stored = model.storage.find((column) => column.key === key);
  if (field?.kind !== "number" || stored === undefined)
    throw new Error(`${entity}.${key} has no additive scalar SQL expression`);
  return terminalSql(entity, `"${getTableName(table)}"`, stored.column);
};
