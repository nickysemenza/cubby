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
import { asc, desc, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";

import { buildOrderBy, buildSearchConditions } from "./database-helpers";
import { declaredFilterPredicates } from "./declared-filter-predicates";
import { lexicalEligibility, lexicalRelevance } from "./search-lexical";

/** Entities with a declared sort roster — the only ones `orderBy` can serve. */
type SortableEntity = keyof typeof generatedEntitySort;

type OrderByOpts = Parameters<typeof buildOrderBy>[3];

const searchableEntityNames = new Set<string>(searchableEntities);
const isSearchableEntity = (entity: string): entity is SearchableEntity =>
  searchableEntityNames.has(entity);
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
    updatedAt: AnyColumn;
    shortcode: AnyColumn;
  },
>(entity: E, table: T) {
  const searchable = isSearchableEntity(entity);
  return {
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
      if (searchable && searchQuery !== undefined && sorts.length === 0) {
        return [
          asc(lexicalRelevance(entity, table.id, searchQuery)),
          desc(table.updatedAt),
          asc(table.shortcode),
        ];
      }
      return buildOrderBy(
        table,
        sorts,
        [...generatedEntitySort[entity].fields],
        {
          ...opts,
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
  };
}
