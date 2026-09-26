import { scoredEntities, type ScoredEntity } from "@cubby/schemas/data-quality";
/**
 * The three boilerplate calls every entity list where-builder repeats —
 * `buildSearchConditions` + `declaredFilterPredicates`, `buildOrderBy` off the
 * generated sort roster, and `buildTakeSkip` — composed once per entity.
 *
 * Deliberately NOT a hook-based generic repository (see
 * `entity-crud-factory.ts`'s header for why repositories stay hand-rolled):
 * a repo keeps its own joins, cross-entity subqueries, `readIntent` branches,
 * and row mappers, and only swaps in these three calls. `where` still takes a
 * `computed` array for everything that isn't a declared stored predicate —
 * related-view conditions, presence over a subquery, resolved-shortcode
 * conditions, OR-groups, `sql\`false\`` guards — exactly what a where-builder
 * already threads through `buildSearchConditions`'s `extraConditions`.
 */
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import {
  searchableEntities,
  type SearchableEntity,
} from "@cubby/schemas/search";
import {
  asc,
  desc,
  sql,
  type AnyColumn,
  type InferSelectModel,
  type SQL,
} from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";

import {
  dataQualityFilterPredicates,
  dataQualitySortResolver,
} from "./data-quality";
import {
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  type ListReadIntent,
  unwrapDb,
} from "./database-helpers";
import { declaredFilterPredicates } from "./declared-filter-predicates";
import { lexicalEligibility, lexicalRelevance } from "./search-lexical";

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
}

interface ListSpec<Row, Out> {
  /**
   * The row query. Omit for a flat `SELECT *` over the table; pass a
   * relational `findMany` (or a projection) when hydration needs relations.
   */
  select?: (page: ListPage) => Promise<Row[]>;
  /** Rows → API items, batched over the page (quality, images, labels). */
  hydrate: (rows: Row[]) => Promise<Out[]> | Out[];
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
     * `computed` is every condition that isn't a declared stored predicate —
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
      const { data, count } = await executeListQueryWithCount({
        kind: request.readIntent ?? "page",
        rows: () => selectRows(page),
        count: spec.count ?? (() => countWhere(db, table, where)),
      });
      if (request.readIntent === "count") return { data: [], count };
      return { data: await spec.hydrate(data), count };
    },
  };
  return scaffold;
}
