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
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { compileTraversal } from "~/server/generic/relatedness/repo/traversal";

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
 * Request data a derived field's SQL reads (inventory valuations run WASM
 * over every row). Created once per repository; several fields share one by
 * passing the same handle, and `hydrate` reads its result from the context.
 */
export interface ListPrepare<P> {
  readonly load: (db: Database | DrizzleTransaction) => Promise<P>;
  value(render: (prepared: P) => SQL): PreparedValue;
  predicate<V>(
    render: (prepared: P, value: V) => SQL | undefined,
  ): PreparedPredicate<V>;
}

interface PreparedValue {
  readonly prepare: ListPrepare<unknown>;
  readonly render: (context: ListContext) => SQL;
}

interface PreparedPredicate<V> {
  readonly prepare: ListPrepare<unknown>;
  readonly render: (context: ListContext, value: V) => SQL | undefined;
}

export const listPrepare = <P>(
  load: (db: Database | DrizzleTransaction) => Promise<P>,
): ListPrepare<P> => {
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

type DerivedValueSql = SQL | PreparedValue;
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

/** A derived value field's SQL in `context`. */
export const derivedValueSql = (
  entity: Entity,
  derived: AnyDerivedSql,
  key: string,
  context: ListContext,
): SQL => {
  const entry = derived[key];
  if (entry === undefined || typeof entry === "function")
    throw missingSql(entity, key);
  // SAFETY: `DerivedSqlArg` gives a value key only `SQL` or a prepared value,
  // never a predicate's function or prepared predicate.
  return isPrepared(entry)
    ? (entry as PreparedValue).render(context)
    : (entry as SQL);
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

/** The scalar a to-one `via` path reads: the terminal field or record title. */
const relatedScalarSql = (
  entity: Entity,
  field: ViaField,
  outerId: AnyColumn,
): SQL => {
  if (field.sort !== null)
    throw createAppError("CONSTRAINT_VIOLATION", field.sort);
  const { from, root, leaf } = viaParts(entity, field);
  const column =
    field.terminal.kind === "field"
      ? field.terminal.column
      : field.terminal.titleColumn;
  if (column === null)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${entity}.${field.path} has no stored title`,
    );
  return sql`(SELECT ${leaf}.${sql.identifier(column)} FROM ${from} WHERE ${root}."id" = ${outerId})`;
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
 * The ORDER BY expression of a declared derived field, or null for a field
 * this compiler does not own. A rejected field (a to-many path, a filter-only
 * predicate) fails with the reason the declaration derives.
 */
export const derivedOrderBy = (
  entity: Entity,
  derived: AnyDerivedSql,
  sort: SortParams,
  outerId: AnyColumn,
  context: ListContext,
): SQL[] | null => {
  const field = derivedFieldsOf(entity)[sort.orderBy];
  if (field === undefined) return null;
  const value =
    field.shape === "via"
      ? relatedScalarSql(entity, field, outerId)
      : field.shape === "value"
        ? derivedValueSql(entity, derived, sort.orderBy, context)
        : null;
  if (value === null)
    throw createAppError("CONSTRAINT_VIOLATION", field.sort ?? sort.orderBy);
  return [
    sql`${value} ${sql.raw(sort.direction === "asc" ? "asc" : "desc")} nulls last`,
  ];
};
