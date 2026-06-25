/**
 * Ingredient search, lookup, and list reads.
 *
 * Name/alias matching for the merge suggester and cookbook importer, the
 * paginated list with its computed sort keys, the lean by-id batch fetch for the
 * costing path, and the enrichment-workbench worklist. None of these mutate.
 */

import type { IngredientId } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { RecipeRef } from "@cubby/schemas/recipe";
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { getSortableFields } from "~/entities/entities";
import type { Database } from "~/server/db";
import {
  ingredient,
  product,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  buildOrderBy,
  countWhere,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";
import {
  appearsInRecipesRefsForIngredientSql,
  computeRecipeUsages,
  cookbookOnlyForIngredientSql,
  liveRecipeCountForIngredientSql,
} from "../recipe";
import {
  buildIngredientWhere,
  dbIngredientToAPI,
  type IngredientDeepDB,
  mapIngredientProducts,
} from "./internal-types";

/**
 * Name-search standalone ingredients for the AI merge suggester's `search`
 * tool — excludes the source ingredient and surfaces each candidate's product
 * count so the model can prefer an already-enriched target (merging inherits its
 * products). Light projection (no relations); capped for the agent loop.
 */
export const searchIngredientsForMerge = async (
  db: Database,
  query: string,
  excludeId: IngredientId,
  limit = 12,
): Promise<{ id: IngredientId; name: string; productCount: number }[]> => {
  const term = formatSearchTerm(ingredient.name, query);
  const rows = await getDb(db)
    .select({
      id: ingredient.id,
      name: ingredient.name,
      productCount: sql<number>`(SELECT count(*) FROM "Product" p WHERE p."ingredientId" = ${ingredient.id} AND p."deletedAt" IS NULL)`,
    })
    .from(ingredient)
    .where(
      and(
        notDeleted(ingredient),
        isNull(ingredient.recipeId),
        ne(ingredient.id, excludeId),
        ...(term ? [term] : []),
      ),
    )
    .limit(limit);
  return rows.map((r) => ({ ...r, productCount: Number(r.productCount) }));
};

/**
 * Lean fetch of an ingredient's recipe usages — just the RecipeSectionIngredient
 * rows joined to their section + recipe, shaped by {@link computeRecipeUsages}.
 * Used by the product detail view (via the linked ingredient) to render "Appears
 * In Recipes" without loading the full ingredient graph (its other products and
 * their unit mappings).
 */
export const getRecipeUsagesForIngredient = async (
  db: Database,
  ingredientId: IngredientId,
) => {
  const rows = await getDb(db).query.recipeSectionIngredient.findMany({
    where: and(
      eq(recipeSectionIngredient.ingredientId, ingredientId),
      notDeleted(recipeSectionIngredient),
    ),
    with: {
      recipeSection: {
        with: { recipe: true },
      },
    },
  });
  return computeRecipeUsages(rows);
};

/**
 * Lean batched fetch by id for the costing path: ingredients + their products
 * (mappings / images / external ids), in ONE query via `inArray`. Deliberately
 * drops the recipe-usage relation that the full ingredient graph carries (the
 * per-usage Recipe + RecipeSection jsonb bodies) — costing, getManyByIDs, and the
 * unit-mapping analysis only read products/food, so that's a needless over-fetch
 * (~1s on a recipe's ingredient set). Missing/deleted ids are silently omitted.
 */
export const getIngredientsByIDsLean = async (
  db: Database,
  ids: IngredientId[],
) => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.ingredient.findMany({
    where: and(inArray(ingredient.id, ids), notDeleted(ingredient)),
    with: {
      product: {
        with: {
          unitMappings: true,
          externalIds: true,
          images: { with: { image: true } },
        },
      },
    },
  });
  return rows.map((row) => {
    const { product: productRel, ...restOfIngredient } = row;
    return { ...restOfIngredient, product: mapIngredientProducts(productRel) };
  });
};

/**
 * Lean fetch for the enrichment workbench: every recipe-used standalone
 * ingredient with its products (mappings / images / external ids) plus two
 * computed scalars — `recipeCount` and `cookbookOnly`. The workbench sizes and
 * filters its worklist from these WITHOUT shipping recipe bodies: the
 * `relations.ingredient.full` path embeds the full Recipe + RecipeSection (jsonb
 * `instructions`/`totals`/`notes`) once per RSI usage — a ~24 MB payload for
 * ~1.4k ingredients that made this query ~40s (transfer + JS marshalling, not
 * Postgres). Recipe usages for the expanded-row footer load on demand via
 * {@link getRecipeUsagesForIngredient}.
 */
export const enrichmentWorkbenchIngredients = async (db: Database) => {
  // The relational query builder rewrites column refs in a custom orderBy/extras
  // to the root alias, so these correlated subqueries MUST be raw strings
  // hand-qualified to "ingredient"."id" (see ingredientList's orderBy note).
  const ref = '"ingredient"."id"';
  const recipeCountSql = liveRecipeCountForIngredientSql(ref);
  const rows = await getDb(db).query.ingredient.findMany({
    where: and(
      isNull(ingredient.recipeId),
      notDeleted(ingredient),
      // Skip the long tail of never-used ingredients up front — the workbench is
      // a worklist of recipe-used gaps.
      sql.raw(`${recipeCountSql} > 0`),
    ),
    with: {
      product: {
        with: {
          unitMappings: true,
          externalIds: true,
          images: { with: { image: true } },
        },
      },
    },
    extras: {
      recipeCount: sql<number>`${sql.raw(recipeCountSql)}`.as("recipeCount"),
      cookbookOnly: sql<boolean>`${sql.raw(
        cookbookOnlyForIngredientSql(ref),
      )}`.as("cookbookOnly"),
    },
    orderBy: [sql.raw(`${recipeCountSql} desc nulls last`)],
  });
  return rows.map((row) => {
    const {
      product: productRel,
      recipeCount,
      cookbookOnly,
      ...restOfIngredient
    } = row;
    return {
      ...restOfIngredient,
      product: mapIngredientProducts(productRel),
      // count() returns bigint (string over the wire), so coerce; the boolean comes
      // back native — `=== true` avoids the Boolean("false") === true trap if a
      // future driver ever stringifies it.
      recipeCount: Number(recipeCount),
      cookbookOnly: cookbookOnly === true,
    };
  });
};

export const getIngredientByName = async (db: Database, name: string) => {
  const res = await getDb(db).query.ingredient.findFirst({
    where: buildIngredientWhere(true, name),
    ...relations.ingredient.full,
  });
  return res ? await dbIngredientToAPI(db, res) : null;
};

/**
 * Batch counterpart to {@link getIngredientByName}: match many names in ONE
 * query (exact, case-insensitive, on name or alias). Returns a map from each
 * requested name to its match (or null). Used by the cookbook importer to show
 * the matched/new status for a whole book's ingredients without firing one
 * request per ingredient per recipe card.
 */
type IngredientNameMatch = {
  id: string;
  name: string;
  aliases: string[];
};

export const getIngredientMatches = async (
  db: Database,
  names: string[],
): Promise<Record<string, IngredientNameMatch | null>> => {
  const map: Record<string, IngredientNameMatch | null> = {};
  for (const n of names) map[n] = null;
  if (names.length === 0) return map;

  const rows = await getDb(db).query.ingredient.findMany({
    where: buildIngredientWhere(true, names[0]!, names.slice(1)),
    columns: { id: true, name: true, aliases: true },
  });

  // Index each row by its lowercased name + aliases, then assign every requested
  // name that matches. Aliases are returned so callers (e.g. instruction
  // highlighting) can recognize a matched ingredient by any of its names.
  const byKey = new Map<string, IngredientNameMatch>();
  for (const row of rows) {
    const match = { id: row.id, name: row.name, aliases: row.aliases };
    for (const key of [row.name, ...row.aliases]) {
      byKey.set(key.toLowerCase(), match);
    }
  }
  for (const n of names) {
    map[n] = byKey.get(n.toLowerCase()) ?? null;
  }
  return map;
};

export const ingredientList = async (
  db: Database,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
  missingProductsOnly: boolean = false,
) => {
  // Always filter out deleted items and recipe ingredients
  const conditions = [isNull(ingredient.recipeId), notDeleted(ingredient)];

  // Add name filter if provided
  if (name) {
    const nameCondition = buildIngredientWhere(false, name);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  // For missing products filter, we need to use a left join and check for null
  const whereClause = and(...conditions);

  // Build order by. `appearsInRecipes` and `product` are computed counts (not
  // real columns), so sort them via correlated subqueries. These MUST be written
  // with sql.raw: the relational query builder (query.ingredient.findMany)
  // rewrites every column reference in a custom orderBy to the root table's alias
  // ("ingredient"), which mangles cross-table refs. A raw string is opaque to that
  // rewriter, so we hand-qualify the inner tables and correlate to "ingredient"."id".
  // Everything else goes through the generic buildOrderBy.
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";
  const orderByClause =
    sort.orderBy === "appearsInRecipes"
      ? [
          // Shared with global search so the sort key matches the displayed
          // `appearsInRecipes.length` exactly (live recipes/sections/usages only).
          sql.raw(
            `${liveRecipeCountForIngredientSql('"ingredient"."id"')} ${dirSql}`,
          ),
        ]
      : sort.orderBy === "product"
        ? [
            sql.raw(
              `(SELECT count(*) FROM "Product" p ` +
                `WHERE p."ingredientId" = "ingredient"."id" AND p."deletedAt" IS NULL) ${dirSql}`,
            ),
          ]
        : buildOrderBy(ingredient, sort, [...getSortableFields("ingredient")]);

  const { take, skip } = buildTakeSkip(pagination);

  // Lean list shape: products (mapped) + a jsonb {id,name}[] of the recipes the
  // ingredient appears in (the list reads count = length, and the first ref for
  // the pill). Drops the per-usage Recipe + Section jsonb bodies the full graph
  // shipped — the list never reads them (that was the over-fetch).
  const leanRelations = {
    with: {
      product: {
        with: {
          unitMappings: true,
          externalIds: true,
          images: { with: { image: true } },
        },
      },
    },
    extras: {
      appearsInRecipes: sql<RecipeRef[]>`${sql.raw(
        appearsInRecipesRefsForIngredientSql('"ingredient"."id"'),
      )}`.as("appearsInRecipes"),
    },
  } as const;

  const toListItem = <
    R extends {
      product: IngredientDeepDB["product"];
      appearsInRecipes: RecipeRef[];
    },
  >(
    row: R,
  ) => {
    const { product: productRel, appearsInRecipes, ...rest } = row;
    return {
      ...rest,
      product: mapIngredientProducts(productRel),
      appearsInRecipes: appearsInRecipes ?? [],
    };
  };

  if (missingProductsOnly) {
    // Use a subquery to find ingredients with no products
    const ingredientsWithNoProducts = getDb(db)
      .select({ id: ingredient.id })
      .from(ingredient)
      .leftJoin(product, eq(product.ingredientId, ingredient.id))
      .where(and(whereClause, isNull(product.id)))
      .groupBy(ingredient.id)
      .as("filtered");

    const { data: results, count: totalCount } =
      await executeListQueryWithCount(
        getDb(db).query.ingredient.findMany({
          where: inArray(
            ingredient.id,
            getDb(db)
              .select({ id: ingredientsWithNoProducts.id })
              .from(ingredientsWithNoProducts),
          ),
          ...leanRelations,
          orderBy: orderByClause,
          limit: take,
          offset: skip,
        }),
        getDb(db)
          .select({ count: count() })
          .from(ingredient)
          .leftJoin(product, eq(product.ingredientId, ingredient.id))
          .where(and(whereClause, isNull(product.id)))
          .then((rows) => rows[0]?.count ?? 0),
      );

    return { data: results.map(toListItem), count: totalCount };
  } else {
    // Normal query without missing products filter
    const { data: results, count: totalCount } =
      await executeListQueryWithCount(
        getDb(db).query.ingredient.findMany({
          where: whereClause,
          ...leanRelations,
          orderBy: orderByClause,
          limit: take,
          offset: skip,
        }),
        countWhere(db, ingredient, whereClause),
      );

    return { data: results.map(toListItem), count: totalCount };
  }
};
