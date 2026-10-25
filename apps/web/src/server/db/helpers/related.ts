/**
 * Correlated aggregates over a list's related rows, without hand-qualified
 * SQL strings.
 *
 * Drizzle renders interpolated columns bare inside a single-table SELECT's
 * fields — aliased tables included — so a correlated `${expense.cost}` or
 * `${purchase.id}` can bind to the wrong row. This module therefore renders
 * identifiers itself: each related step is a typed map of `"rN"."column"`
 * fragments, and {@link outer} always renders `"Table"."column"`. Every step
 * is live (`deletedAt IS NULL`) unless it opts out with `includeDeleted`.
 */
import {
  type AnyColumn,
  getTableColumns,
  getTableName,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * A table's quoted name, from its Drizzle declaration, for the remaining
 * string-built fragments that correlate with an outer select by table name.
 * Call sites never spell the name by hand, so a rename is a compile error.
 */
export const quotedTable = (table: PgTable): string =>
  `"${getTableName(table).replaceAll('"', '""')}"`;

/** The outer list row's column, always table-qualified. */
export const outer = (column: AnyColumn): SQL =>
  sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;

/** A related step's columns as qualified fragments, keyed like the table. */
export type RelatedColumns<T extends PgTable> = {
  readonly [K in keyof T["_"]["columns"]]: SQL;
};

type StepOptions = { includeDeleted?: boolean };

type Step = {
  readonly from: SQL;
  readonly on: SQL;
  readonly live: SQL | null;
};

let aliasCounter = 0;
/** Unique per step so nested rollups never shadow each other. */
const nextAlias = () => `r${(aliasCounter = (aliasCounter + 1) % 1_000_000)}`;

const columnsOf = <T extends PgTable>(table: T, name: string) =>
  // SAFETY: the entries are exactly `getTableColumns(table)`'s keys, each
  // mapped to its qualified fragment, which is RelatedColumns<T> by definition.
  Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key,
      sql`${sql.identifier(name)}.${sql.identifier(column.name)}`,
    ]),
  ) as RelatedColumns<T>;

const step = <T extends PgTable>(
  table: T,
  on: (columns: RelatedColumns<T>) => SQL,
  options: StepOptions,
) => {
  const name = nextAlias();
  const columns = columnsOf(table, name);
  const deletedAt: SQL | undefined =
    "deletedAt" in getTableColumns(table)
      ? Object.entries(columns).find(([key]) => key === "deletedAt")?.[1]
      : undefined;
  return {
    columns,
    step: {
      from: sql`${sql.identifier(getTableName(table))} ${sql.identifier(name)}`,
      on: on(columns),
      live:
        deletedAt && !options.includeDeleted ? sql`${deletedAt} IS NULL` : null,
    } satisfies Step,
  };
};

class Related<T extends PgTable> {
  constructor(
    readonly columns: RelatedColumns<T>,
    private readonly steps: readonly Step[],
    private readonly conditions: readonly SQL[],
  ) {}

  /**
   * Inner-join the next table of the path; later `where` and aggregates
   * address the joined rows. Its rows are live unless opted out.
   */
  join<J extends PgTable>(
    table: J,
    on: (joined: RelatedColumns<J>, previous: RelatedColumns<T>) => SQL,
    options: StepOptions = {},
  ): Related<J> {
    const joined = step(table, (columns) => on(columns, this.columns), options);
    return new Related(
      joined.columns,
      [...this.steps, joined.step],
      this.conditions,
    );
  }

  /** Further conditions on the related rows. */
  where(condition: (root: RelatedColumns<T>) => SQL | undefined): Related<T> {
    const value = condition(this.columns);
    return value
      ? new Related(this.columns, this.steps, [...this.conditions, value])
      : this;
  }

  private body(): SQL {
    const [first, ...rest] = this.steps;
    if (!first) throw new Error("related() has no table");
    const joins = rest.map(
      (joined) =>
        sql` INNER JOIN ${joined.from} ON ${joined.on}${
          joined.live ? sql` AND ${joined.live}` : sql``
        }`,
    );
    const where = [
      first.on,
      ...(first.live ? [first.live] : []),
      ...this.conditions,
    ];
    return sql`FROM ${first.from}${sql.join(joins, sql``)} WHERE ${sql.join(
      where.map((condition) => sql`(${condition})`),
      sql` AND `,
    )}`;
  }

  count(): SQL<number> {
    return sql<number>`(SELECT count(*)::int ${this.body()})`;
  }

  countDistinct(column: (root: RelatedColumns<T>) => SQL): SQL<number> {
    return sql<number>`(SELECT count(DISTINCT ${column(this.columns)})::int ${this.body()})`;
  }

  /** Zero when there are no rows, matching the lists' numeric totals. */
  sum(column: (root: RelatedColumns<T>) => SQL): SQL<number> {
    return sql<number>`(SELECT COALESCE(sum(${column(this.columns)}), 0)::double precision ${this.body()})`;
  }

  min<V>(column: (root: RelatedColumns<T>) => SQL): SQL<V | null> {
    return sql<V | null>`(SELECT min(${column(this.columns)}) ${this.body()})`;
  }

  max<V>(column: (root: RelatedColumns<T>) => SQL): SQL<V | null> {
    return sql<V | null>`(SELECT max(${column(this.columns)}) ${this.body()})`;
  }

  /** A to-one lookup: the column of the (single) related row, else NULL. */
  value<V>(column: (root: RelatedColumns<T>) => SQL): SQL<V | null> {
    return sql<V | null>`(SELECT ${column(this.columns)} ${this.body()} LIMIT 1)`;
  }

  /**
   * One scan feeding several aggregates: `SELECT <fields> FROM … WHERE …`,
   * for use as a derived table (`FROM (${…aggregate(…)}) agg`).
   */
  aggregate(fields: (root: RelatedColumns<T>) => SQL): SQL {
    return sql`SELECT ${fields(this.columns)} ${this.body()}`;
  }

  exists(): SQL<boolean> {
    return sql<boolean>`EXISTS (SELECT 1 ${this.body()})`;
  }
}

/**
 * Live rows of `table` correlated to the outer row by `on`:
 * `related(expense, (e) => sql\`${e.purchaseId} = ${outer(purchase.id)}\`).sum((e) => e.cost)`.
 */
export const related = <T extends PgTable>(
  table: T,
  on: (columns: RelatedColumns<T>) => SQL,
  options: StepOptions = {},
): Related<T> => {
  const first = step(table, on, options);
  return new Related(first.columns, [first.step], []);
};
