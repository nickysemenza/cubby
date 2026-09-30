/**
 * The one list module every repository composes: the declared stored-filter
 * predicates (`declaredFilterPredicates`) and the per-entity list scaffold
 * (`listScaffold`) that binds them with the data-quality filters, audit
 * dates, lexical search, the generated sort roster and paging.
 */
import { scoredEntities, type ScoredEntity } from "@cubby/schemas/data-quality";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import {
  buildTakeSkip,
  type PaginationParams,
  presenceFilter,
  type SortParams,
} from "@cubby/schemas/pagination";
import {
  searchableEntities,
  type SearchableEntity,
} from "@cubby/schemas/search";
import {
  type AnyColumn,
  asc,
  desc,
  getTableColumns,
  getTableName,
  type InferSelectModel,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";

import {
  dataQualityFilterPredicates,
  dataQualitySortResolver,
} from "./data-quality";
import {
  arrayOverlapOrPresence,
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
  type ListReadIntent,
  presenceCondition,
  rangeConditions,
  shortcodeSetCondition,
  textArrayMatches,
  unwrapDb,
} from "./database-helpers";
import { SHORTCODE_TABLE } from "./generated/shortcode-tables.gen";
import type { ListProjection } from "./list-projection";
import { withListReadTracing } from "./list-read-tracing";
import { relatedWhereConditions } from "./related-view";
import { lexicalEligibility, lexicalRelevance } from "./search-lexical";

const filterValues = z.record(z.string(), z.unknown());
const optionalText = z.string().optional();
const optionalNumber = z.number().optional();
const optionalDate = z.string().optional();
const optionalBoolean = z.boolean().optional();
const optionalTextList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => (value === undefined ? undefined : [value].flat()));

/** The descriptor facets this helper reads, independent of the literal roster. */
interface StoredDescriptorView {
  readonly columnId: string;
  readonly field: string | null;
  readonly kind: string;
  readonly stored: Readonly<{
    columns: readonly string[];
    array: boolean;
  }> | null;
  readonly nullable: Readonly<{ field: string }> | null;
  readonly range: Readonly<{ kind: "number" | "date" }> | null;
}

/** A stored column resolved to its table column and declared storage facts. */
interface StoredColumn {
  readonly column: AnyColumn;
  readonly kind: string;
  readonly nullable: boolean;
  /** The entity a foreign-key column points at, for `id`/`idMulti` filters. */
  readonly reference: string | null;
}

const descriptorsFor = (entity: Entity): readonly StoredDescriptorView[] =>
  Object.entries(entityInspectorMetadata).find(([key]) => key === entity)?.[1]
    .filterDescriptors ?? [];
const fieldModelFor = (entity: Entity) =>
  Object.entries(entityFieldModels).find(([key]) => key === entity)?.[1];

const storedColumns = (
  entity: Entity,
  table: PgTable,
  descriptor: StoredDescriptorView,
): StoredColumn[] => {
  const storage = fieldModelFor(entity)?.storage ?? [];
  const columns: Record<string, AnyColumn> = getTableColumns(table);
  return (descriptor.stored?.columns ?? []).map((key) => {
    const stored = storage.find(({ key: k }) => k === key);
    const column =
      columns[key] ??
      Object.values(columns).find((c) => c.name === stored?.column);
    if (!column || !stored)
      throw new Error(
        `${entity}.${descriptor.columnId} has no table column ${key} for its stored filter`,
      );
    return {
      column,
      kind: stored.kind,
      nullable: stored.nullable,
      reference: stored.reference,
    };
  });
};

/** `formatSearchTerm` over every declared column, `text[]` columns by element. */
const textPredicate = (
  columns: readonly StoredColumn[],
  term: string | undefined,
): SQL | undefined =>
  or(
    ...columns.map(({ column, kind }) =>
      kind === "text-array"
        ? textArrayMatches(column, term)
        : formatSearchTerm(column, term),
    ),
  );

/**
 * A boolean filter over a boolean column is equality; over any other
 * (nullable) column it is presence: `true` is NOT NULL, `false` is NULL.
 */
const booleanPredicate = (
  { column, kind }: StoredColumn,
  flag: boolean | undefined,
): SQL | undefined =>
  kind === "boolean"
    ? eqAny(column, flag)
    : presenceCondition(
        column,
        flag === undefined ? undefined : flag ? "has" : "none",
      );

/**
 * An id filter over a foreign-key column: the column is in the set of ids
 * whose public shortcode was requested. The referenced table is aliased so a
 * self-reference (a location's parent) never collides with the outer row,
 * and the outer column stays a Drizzle column so the relational list query
 * can re-alias it (see `list-smoke.integration.test.ts`).
 */
const referencePredicate = (
  entity: Entity,
  { column, reference }: StoredColumn,
  codes: readonly string[] | undefined,
): SQL | undefined => {
  if (codes === undefined) return undefined;
  const table = Object.entries(SHORTCODE_TABLE).find(
    ([key]) => key === reference,
  )?.[1];
  if (!table)
    throw new Error(
      `${entity} id filter over ${column.name} references ${String(reference)}, which has no shortcode table`,
    );
  const requested = shortcodeSetCondition(sql`ref."shortcode"`, codes);
  return sql`${column} IN (SELECT ref."id" FROM ${sql.identifier(getTableName(table))} ref WHERE ${requested})`;
};

const dateRange = (
  column: AnyColumn,
  from: string | undefined,
  to: string | undefined,
): Array<SQL | undefined> => [
  from === undefined ? undefined : sql`${column} >= ${from}`,
  to === undefined ? undefined : sql`${column} <= ${to}`,
];

/**
 * The predicates a repository owes to descriptors declared `stored`: the
 * standard column predicate for each descriptor kind over the declared
 * stored columns. Text is a substring match ORed across its columns (a
 * `text[]` column matches by element), enum filters are equality or
 * membership with the declared nullable presence filter ORed in, a
 * multiselect declared `array` is an overlap with the same presence rule,
 * boolean is equality or presence, presence checks NULL, ranges are
 * inclusive bounds, and an id filter matches a foreign key by the referenced
 * row's shortcode. Anything richer (joins, OR groups across filters,
 * resolved ids) stays hand-written next to this spread in the repository's
 * where builder.
 */
export function declaredFilterPredicates<Filters extends object>(
  entity: Entity,
  table: PgTable,
  filters: Filters,
): Array<SQL | undefined> {
  const values = filterValues.parse(filters);
  return descriptorsFor(entity)
    .filter((descriptor) => descriptor.stored !== null)
    .flatMap((descriptor): Array<SQL | undefined> => {
      const key = descriptor.field ?? descriptor.columnId;
      const columns = storedColumns(entity, table, descriptor);
      const [first] = columns;
      if (first === undefined) return [];
      const value = values[key];
      const presence = descriptor.nullable
        ? presenceFilter.parse(values[descriptor.nullable.field])
        : undefined;
      switch (descriptor.kind) {
        case "text":
          return [textPredicate(columns, optionalText.parse(value)?.trim())];
        case "boolean":
          return [booleanPredicate(first, optionalBoolean.parse(value))];
        case "select":
        case "multiselect":
          return [
            descriptor.stored?.array
              ? arrayOverlapOrPresence(
                  first.column,
                  optionalTextList.parse(value),
                  presence,
                  first.nullable,
                )
              : descriptor.nullable
                ? eqAnyOrPresence(first.column, value, presence)
                : eqAny(first.column, value),
          ];
        case "presence":
          return [presenceCondition(first.column, presenceFilter.parse(value))];
        case "id":
        case "idMulti":
          return [
            referencePredicate(entity, first, optionalTextList.parse(value)),
          ];
        case "range":
          return descriptor.range?.kind === "date"
            ? dateRange(
                first.column,
                optionalDate.parse(values[`${key}From`]),
                optionalDate.parse(values[`${key}To`]),
              )
            : rangeConditions(
                first.column,
                {
                  [`${key}Min`]: optionalNumber.parse(values[`${key}Min`]),
                  [`${key}Max`]: optionalNumber.parse(values[`${key}Max`]),
                },
                key,
              );
        default:
          throw new Error(
            `${entity}.${descriptor.columnId} cannot derive a ${descriptor.kind} predicate`,
          );
      }
    });
}

/**
 * The three boilerplate calls every entity list where-builder repeats —
 * `buildSearchConditions` + `declaredFilterPredicates`, `buildOrderBy` off the
 * generated sort roster, and `buildTakeSkip` — composed once per entity.
 *
 * A repository (`defineRepository`) keeps its own joins, cross-entity
 * subqueries, `readIntent` branches and row mappers, and only swaps in these
 * three calls. `where` still takes a
 * `computed` array for everything that isn't a declared stored predicate —
 * related-view conditions, presence over a subquery, resolved-shortcode
 * conditions, OR-groups, `sql\`false\`` guards — exactly what a where-builder
 * already threads through `buildSearchConditions`'s `extraConditions`.
 */
/** Entities with a declared sort roster — the only ones `orderBy` can serve. */
type SortableEntity = keyof typeof generatedEntitySort;

type OrderByOpts = Parameters<typeof buildOrderBy>[3];

/** The already-built clauses a list's row query applies. */
export interface ListPage {
  where: SQL | undefined;
  orderBy: SQL[];
  limit: number;
  offset: number;
}

interface ListRequest<Filters extends object> {
  filters: Filters;
  sorts: SortParams[];
  pagination: PaginationParams;
  readIntent?: ListReadIntent;
  projection?: ListProjection;
}

interface ListSpec<Row, Out> {
  /**
   * The row query. Omit for a flat `SELECT *` over the table; pass a
   * relational `findMany` (or a projection) when hydration needs relations.
   */
  select?: (page: ListPage, projection: ListProjection) => Promise<Row[]>;
  /** Rows → API items, batched over the page (quality, images, labels). */
  hydrate: (rows: Row[], projection: ListProjection) => Promise<Out[]> | Out[];
  /** Pre-built where; defaults to `where(filters)` with no computed terms. */
  where?: SQL | undefined;
  resolveSort?: NonNullable<OrderByOpts>["resolve"];
  tieBreaker?: SQL;
  /** For a row query whose `where` is bound to a relational-query alias. */
  count?: () => Promise<number>;
}

const searchableEntityNames = new Set<string>(searchableEntities);
const isSearchableEntity = (entity: string): entity is SearchableEntity =>
  searchableEntityNames.has(entity);
const scoredEntityNames = new Set<string>(scoredEntities);
const isScoredEntity = (entity: string): entity is ScoredEntity =>
  scoredEntityNames.has(entity);
const listSearchSchema = z
  .object({ searchQuery: z.string().trim().min(1).max(100).optional() })
  .passthrough();
const listIdsSchema = z
  .object({ ids: z.array(z.string()).optional() })
  .passthrough();
/** Shared by scaffold lists and repositories with a custom WHERE builder. */
export const listIdsCondition = (shortcode: AnyColumn, filters: unknown) =>
  shortcodeSetCondition(sql`${shortcode}`, listIdsSchema.parse(filters).ids);

const searchQueryFromFilters = <Filters extends object>(
  filters: Filters | undefined,
) => listSearchSchema.parse(filters ?? {}).searchQuery;

/**
 * `entity`/`table` scope the three helpers to one entity's list. Call once per
 * where-builder (module scope is fine — nothing here is request-scoped).
 */
export function listScaffold<
  E extends SortableEntity,
  T extends PgTable & {
    id: AnyColumn;
    deletedAt: AnyColumn;
    createdAt: AnyColumn;
    updatedAt: AnyColumn;
    shortcode: AnyColumn;
  },
>(entity: E, table: T) {
  const searchable = isSearchableEntity(entity);
  // A scored entity's `dataStatus`/`dataGap` filters and `dataQualityScore`
  // sort are declared by the manifest block, so they bind here for every
  // list at once rather than beside each repo's own conditions.
  const scored = isScoredEntity(entity) ? entity : null;
  const scoreSort = scored ? dataQualitySortResolver(scored, table) : null;
  const scaffold = {
    /**
     * `computed` is every condition that isn't a declared stored or
     * related-view predicate —
     * append it exactly where the repo's own extra conditions already live.
     */
    where<Filters extends object>(
      filters: Filters,
      computed: Array<SQL | undefined> = [],
    ): SQL | undefined {
      return buildSearchConditions(
        table,
        [],
        [
          ...declaredFilterPredicates(entity, table, filters),
          ...(scored
            ? dataQualityFilterPredicates(scored, table, filters)
            : []),
          ...auditDateWhereConditions(table, filters),
          // The declared related-view filters (`related-<key>`, `<prefix>Id`,
          // `<prefix>PresenceFilter`, `<prefix>Search`) for every list.
          ...relatedWhereConditions(entity, filters, table.id),
          // The kernel's `filters.ids` restriction, by canonical shortcode.
          listIdsCondition(table.shortcode, filters),
          ...(searchable
            ? [
                lexicalEligibility(
                  entity,
                  table.id,
                  searchQueryFromFilters(filters),
                ),
              ]
            : []),
          ...computed,
        ],
      );
    },

    orderBy<Filters extends object>(
      sorts: SortParams[],
      opts?: OrderByOpts,
      filters?: Filters,
    ): SQL[] {
      const searchQuery = searchQueryFromFilters(filters);
      return buildOrderBy(
        table,
        sorts,
        [...generatedEntitySort[entity].fields],
        {
          ...opts,
          leadingOrderBy:
            searchable && searchQuery !== undefined && sorts.length === 0
              ? [
                  asc(lexicalRelevance(entity, table.id, searchQuery)),
                  desc(table.updatedAt),
                ]
              : undefined,
          resolve: (sort) => scoreSort?.(sort) ?? opts?.resolve?.(sort) ?? null,
          // Offset pagination must be deterministic. Repositories may keep a
          // domain-specific tie-breaker, but every explicit list sort then
          // lands on the public shortcode before the private primary key.
          tieBreaker: opts?.tieBreaker
            ? sql`${opts.tieBreaker}, ${table.shortcode} asc`
            : sql`${table.shortcode} asc`,
        },
      );
    },

    page(pagination: PaginationParams): { take: number; skip: number } {
      return buildTakeSkip(pagination);
    },

    /**
     * One list read: where → order → page → rows + count → hydrate. A
     * `count` read never runs the row query or hydration.
     */
    async list<Filters extends object, Out, Row = InferSelectModel<T>>(
      db: Database | DrizzleTransaction,
      request: ListRequest<Filters>,
      spec: ListSpec<Row, Out>,
    ): Promise<{ data: Out[]; count: number }> {
      const where =
        "where" in spec ? spec.where : scaffold.where(request.filters);
      const projection = request.projection ?? { kind: "full" };
      const { take, skip } = buildTakeSkip(request.pagination);
      const page: ListPage = {
        where,
        orderBy: scaffold.orderBy(
          request.sorts,
          { resolve: spec.resolveSort, tieBreaker: spec.tieBreaker },
          request.filters,
        ),
        limit: take,
        offset: skip,
      };
      const selectRows =
        spec.select ??
        (async (clauses: ListPage) =>
          // SAFETY: `SELECT *` over `table` returns exactly its inferred row.
          (await unwrapDb(db)
            .select()
            .from(table as PgTable)
            .where(clauses.where)
            .orderBy(...clauses.orderBy)
            .limit(clauses.limit)
            .offset(clauses.offset)) as Row[]);
      return withListReadTracing(
        { entity, projection: projection.kind },
        async () => {
          const { data, count } = await executeListQueryWithCount({
            kind: request.readIntent ?? "page",
            rows: () => selectRows(page, projection),
            count: spec.count ?? (() => countWhere(db, table, where)),
          });
          if (request.readIntent === "count") return { data: [], count };
          return withListReadTracing({ rows: data.length }, async () => ({
            data: await spec.hydrate(data, projection),
            count,
          }));
        },
      );
    },
  };
  return scaffold;
}
