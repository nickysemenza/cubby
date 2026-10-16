/**
 * The list field compiler: one SQL expression per declared list field, so a
 * filter, a sort and a group on the same field address the same path. Own
 * columns compile in `declaredFilterPredicates`/`buildOrderBy`; this module
 * owns the `model.derived` shapes (a related `via` path, a repository value,
 * a declared predicate) and the request-scoped `prepare` step their SQL may
 * read.
 */
import type { Entity } from "@cubby/schemas/entity";
import {
  type GeneratedDerivedPredicateKey,
  type GeneratedDerivedValueKey,
  type GeneratedListField,
  generatedEntityListFields,
} from "@cubby/schemas/entity-list-fields";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import type { SortParams } from "@cubby/schemas/pagination";
import { type AnyColumn, getTableName, SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { relatedSortExpression } from "~/server/generic/entity-links/repo/related-view";
import {
  compileTraversal,
  renderJoins,
} from "~/server/generic/relatedness/repo/traversal";

/** A list request's raw filter values, by URL key. */
export const listFilterValues = z.record(z.string(), z.unknown());
export type ListFilterValues = z.output<typeof listFilterValues>;

type ListFields = typeof generatedEntityListFields;
type DerivedField = GeneratedListField;
type ViaField = Extract<DerivedField, { shape: "via" }>;
type PredicateKind = Extract<DerivedField, { shape: "predicate" }>["predicate"];

/** The parsed filter value a declared predicate receives, by its kind. */
interface PredicateValues {
  text: string;
  select: readonly string[];
  multiselect: readonly string[];
  boolean: boolean;
}

/**
 * A derived value's SQL: one expression, or a compound key whose parts order
 * in turn (inventory `amount` is a unit, then a size). A compound value sorts
 * and groups but cannot filter.
 */
type DerivedValue = SQL | readonly [SQL, ...SQL[]];

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
  readonly load: PrepareLoad<P>;
  value(render: (prepared: P) => DerivedValue): PreparedValue;
  predicate<V>(
    render: (prepared: P, value: V) => SQL | undefined,
  ): PreparedPredicate<V>;
}

interface PreparedValue {
  readonly prepare: ListPrepare<unknown>;
  readonly render: (context: ListContext) => DerivedValue;
}

interface PreparedPredicate<V> {
  readonly prepare: ListPrepare<unknown>;
  readonly render: (context: ListContext, value: V) => SQL | undefined;
}

export const listPrepare = <P>(load: PrepareLoad<P>): ListPrepare<P> => {
  const handle: ListPrepare<P> = {
    load,
    value: (render) => ({
      prepare: handle,
      render: (context) => render(context.get(handle)),
    }),
    predicate: (render) => ({
      prepare: handle,
      render: (context, value) => render(context.get(handle), value),
    }),
  };
  return handle;
};

/** The prepared data of one list request, loaded by `scaffold.context`. */
export class ListContext {
  constructor(
    private readonly prepared: ReadonlyMap<ListPrepare<unknown>, unknown>,
  ) {}

  static readonly empty = new ListContext(new Map());

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

type DerivedValueSql = DerivedValue | PreparedValue;
type DerivedPredicateSql<V> =
  | ((value: V) => SQL | undefined)
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
): readonly SQL[] => {
  const entry = derived[key];
  if (entry === undefined || typeof entry === "function")
    throw missingSql(entity, key);
  // SAFETY: `DerivedSqlArg` gives a value key only a value or a prepared
  // value, never a predicate's function or prepared predicate.
  const value = isPrepared(entry)
    ? (entry as PreparedValue).render(context)
    : (entry as DerivedValue);
  return value instanceof SQL ? [value] : value;
};

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
  return value;
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
    return (entry as (value: V) => SQL | undefined)(value);
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
    leafTable: traversal.leafTable,
  };
};

/**
 * The scalar a to-one `via` path reads: the terminal field or record title.
 * The path starts at the outer row itself, so the subquery probes only the
 * related tables rather than re-reading the root by id.
 */
const relatedScalarSql = (
  entity: Entity,
  field: ViaField,
  table: PgTable,
): SQL => {
  if (field.sort !== null)
    throw createAppError("CONSTRAINT_VIOLATION", field.sort);
  const traversal = compileTraversal(entity, field.steps, "lf", {
    to: field.target,
    root: `"${getTableName(table)}"`,
  });
  const [first, ...rest] = traversal.hops;
  if (first === undefined)
    throw new Error(`${entity}.${field.path} has no relation step`);
  const column =
    field.terminal.kind === "field"
      ? field.terminal.column
      : field.terminal.titleColumn;
  if (column === null)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${entity}.${field.path} has no stored title`,
    );
  const firstAlias = sql.raw(first.alias);
  return sql`(SELECT ${sql.raw(traversal.leafAlias)}.${sql.identifier(column)} FROM ${sql.identifier(first.relation ?? first.table)} ${firstAlias} ${renderJoins({ hops: rest })} WHERE (${first.condition})${
    first.softDelete ? sql` AND ${firstAlias}."deletedAt" IS NULL` : sql``
  })`;
};

/** `EXISTS` over a `via` path (any cardinality) whose terminal row matches. */
export const relatedExistsSql = (
  entity: Entity,
  field: ViaField,
  outerId: AnyColumn,
  matches: (leaf: SQL, column: SQL) => SQL | undefined,
): SQL | undefined => {
  const { from, root, leaf } = viaParts(entity, field);
  const column = sql`${leaf}.${sql.identifier(
    field.terminal.kind === "field"
      ? field.terminal.column
      : (field.terminal.titleColumn ?? "id"),
  )}`;
  const condition = matches(leaf, column);
  if (condition === undefined) return undefined;
  return sql`EXISTS (SELECT 1 FROM ${from} WHERE ${root}."id" = ${outerId} AND ${condition})`;
};

/** The id subquery of the requested public shortcodes of `target`. */
export const shortcodeIdsSql = (
  target: Entity,
  condition: (shortcode: SQL) => SQL | undefined,
): SQL => {
  const table = entityManifest[target].dbTable;
  if (table === null) throw new Error(`${target} has no table to filter by`);
  return sql`(SELECT ref."id" FROM ${sql.identifier(table)} ref WHERE ${
    condition(sql`ref."shortcode"`) ?? sql`false`
  })`;
};

/**
 * The ORDER BY of a declared derived field or a `related:<view>` roster
 * column, or null for a field this compiler does not own. A rejected field (a
 * to-many path, a filter-only predicate) fails with the reason the
 * declaration derives. Every part orders NULLS LAST in both directions, the
 * convention `buildOrderBy` applies to stored columns.
 */
export const derivedOrderBy = (
  entity: Entity,
  derived: AnyDerivedSql,
  sort: SortParams,
  table: PgTable,
  context: ListContext,
): SQL[] | null => {
  const direction = sql.raw(sort.direction === "asc" ? "asc" : "desc");
  const order = (parts: readonly SQL[]) =>
    parts.map((part) => sql`${part} ${direction} nulls last`);
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
    case "predicate":
      throw createAppError("CONSTRAINT_VIOLATION", field.sort);
  }
};
