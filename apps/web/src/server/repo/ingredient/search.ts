/**
 * Ingredient search, lookup, and list reads.
 *
 * Name/alias matching for the merge suggester and cookbook importer, the
 * paginated list with its computed sort keys, the lean by-id batch fetch for the
 * costing path, and the enrichment-workbench worklist. None of these mutate.
 */

import {
  type IngredientId,
  type IngredientShortcode,
  unsafeIngredientShortcode,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import type {
  IngredientFilters,
  IngredientMergeCandidateImpact,
} from "@cubby/schemas/ingredient";
import { ingredientSortableFields } from "@cubby/schemas/ingredient";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { RecipeRef } from "@cubby/schemas/recipe";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  product,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  auditDateWhereConditions,
  buildOrderBy,
  countWhere,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  idSetPresence,
  imageOrder,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";
import { enrichProductRowsWithPricing } from "~/server/repo/product/pricing";
import { lookupShortcodes, refKey } from "~/server/repo/shortcode-resolver";
import {
  appearsInRecipesRefsForIngredientSql,
  computeRecipeUsages,
  cookbookOnlyForIngredientSql,
  liveRecipeCountForIngredientSql,
} from "../recipe";
import { buildIngredientWhere } from "./internal-types";
import {
  dbIngredientToAPI,
  dbIngredientToListAPI,
  dbIngredientToTopLevelShape,
  mapIngredientProducts,
  mapIngredientProductsLean,
} from "./mappers";

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
): Promise<
  {
    id: IngredientId;
    shortcode: string;
    name: string;
    productCount: number;
  }[]
> => {
  const term = formatSearchTerm(ingredient.name, query);
  const rows = await getDb(db)
    .select({
      id: ingredient.id,
      shortcode: ingredient.shortcode,
      name: ingredient.name,
      // ⚠️ `"Ingredient"."id"` hand-qualified, NOT an interpolated
      // `${ingredient.id}`. For a single-table `select().from(x)` Drizzle's
      // `buildSelection` rewrites a top-level `PgColumn` chunk inside a `sql`
      // select field to a BARE identifier, so the interpolated form emitted
      // `p."ingredientId" = "id"` — which binds to the subquery's own `p.id` and
      // is never true. This count read 0 for every candidate, silently killing the
      // merge suggester's "prefer an already-enriched target" signal. Same trap
      // documented at length in repo/purchase.ts.
      productCount: sql<number>`(
        SELECT count(*) FROM "Product" p
        WHERE p."ingredientId" = "Ingredient"."id" AND p."deletedAt" IS NULL
      )`,
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
 * Merge preview: for each candidate ingredient, how much of the "worth keeping"
 * signal it carries — distinct recipe usages, non-deleted linked products, alias
 * count, and whether any linked product has a USDA-resolvable reference
 * (`fdc_id` or `upc`). Read-only; one query per axis (all `inArray`, not N).
 * Used by the merge-confirmation picker to default the keeper to the best
 * candidate and show the per-row counts. Missing/deleted ids are omitted.
 */
export const mergeImpactForIngredients = async (
  db: Database,
  ids: IngredientId[],
): Promise<IngredientMergeCandidateImpact[]> => {
  if (ids.length === 0) return [];
  const dbClient = getDb(db);

  // Base rows: name + alias count. Filters deleted so a stale id contributes
  // nothing (and drops out of the result entirely).
  const bases = await dbClient
    .select({
      id: ingredient.id,
      shortcode: ingredient.shortcode,
      name: ingredient.name,
    })
    .from(ingredient)
    .where(and(inArray(ingredient.id, ids), notDeleted(ingredient)));
  if (bases.length === 0) return [];

  const liveIds = bases.map((b) => b.id);

  // Distinct recipe count per ingredient (via any live section).
  const recipeRows = await dbClient
    .select({
      ingredientId: recipeSectionIngredient.ingredientId,
      recipeCount: sql<number>`count(distinct ${recipeSectionIngredient.recipeSectionId})`,
    })
    .from(recipeSectionIngredient)
    .where(
      and(
        inArray(recipeSectionIngredient.ingredientId, liveIds),
        notDeleted(recipeSectionIngredient),
      ),
    )
    .groupBy(recipeSectionIngredient.ingredientId);
  const recipeCountById = new Map(
    recipeRows.map((r) => [r.ingredientId, Number(r.recipeCount)]),
  );

  // Non-deleted product count + USDA-linkability per ingredient.
  const productRows = await dbClient
    .select({
      ingredientId: product.ingredientId,
      productCount: sql<number>`count(*)`,
      hasUsdaLink: sql<boolean>`bool_or(${product.fdc_id} is not null or ${product.upc} is not null)`,
    })
    .from(product)
    .where(and(inArray(product.ingredientId, liveIds), notDeleted(product)))
    .groupBy(product.ingredientId);
  const productStatsById = new Map(
    productRows.map((r) => [
      r.ingredientId,
      { count: Number(r.productCount), hasUsdaLink: r.hasUsdaLink === true },
    ]),
  );

  // Alias count read from the base table (a text[] column) so it needs no join.
  const aliasRows = await dbClient
    .select({
      id: ingredient.id,
      aliasCount: sql<number>`cardinality(${ingredient.aliases})`,
    })
    .from(ingredient)
    .where(inArray(ingredient.id, liveIds));
  const aliasCountById = new Map(
    aliasRows.map((r) => [r.id, Number(r.aliasCount)]),
  );

  return bases.map((b) => {
    const productStats = productStatsById.get(b.id);
    return {
      id: unsafeIngredientShortcode(b.shortcode),
      name: b.name,
      recipeUsageCount: recipeCountById.get(b.id) ?? 0,
      productCount: productStats?.count ?? 0,
      aliasCount: aliasCountById.get(b.id) ?? 0,
      hasUsdaLink: productStats?.hasUsdaLink ?? false,
    };
  });
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
 * Bulk parser-triage dump: every live recipe line currently linked to any of the
 * given ingredients, with its original `rawLine` + parsed modifier/amounts and
 * the owning recipe/section. One `inArray` query (not N) so a junk-ingredient
 * sweep can pull source lines for ~hundreds of ids in a couple of calls. Lines on
 * soft-deleted sections/recipes are dropped. Caller groups by `ingredientId`.
 */
export const getRawLinesForIngredients = async (
  db: Database,
  ingredientIds: IngredientId[],
) => {
  if (ingredientIds.length === 0) return [];
  const rows = await getDb(db).query.recipeSectionIngredient.findMany({
    where: and(
      inArray(recipeSectionIngredient.ingredientId, ingredientIds),
      notDeleted(recipeSectionIngredient),
    ),
    with: { recipeSection: { with: { recipe: true } } },
  });
  const codes = await lookupShortcodes(
    db,
    rows.flatMap((r) => [
      { entity: "ingredient" as const, id: r.ingredientId },
      { entity: "recipe" as const, id: r.recipeSection.recipe.id },
    ]),
  );
  return rows
    .filter(
      (r) =>
        r.recipeSection.deletedAt === null &&
        r.recipeSection.recipe.deletedAt === null,
    )
    .map((r) => ({
      ingredientId: unsafeIngredientShortcode(
        codes.get(refKey("ingredient", r.ingredientId)) ?? "",
      ),
      lineId: r.id,
      rawLine: r.rawLine,
      modifier: r.modifier,
      amounts: r.amounts,
      recipeId: unsafeRecipeShortcode(
        codes.get(refKey("recipe", r.recipeSection.recipe.id)) ?? "",
      ),
      recipeName: r.recipeSection.recipe.name,
      sectionName: r.recipeSection.name,
    }));
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
    // Unit mappings only — NOT images/externalIds. Costing + getManyByIDs never
    // read them, and pulling full Image records here was ~4MB + ~11s of drizzle
    // object-building per call (worker CPU that starved the recompute isolate).
    with: { product: { with: { unitMappings: true } } },
  });
  const pricedProducts = await enrichProductRowsWithPricing(
    db,
    rows.flatMap((row) => row.product),
  );
  const pricingById = new Map(
    pricedProducts.map((product) => [product.id, product.pricing]),
  );
  return rows.map((row) => {
    const { product: productRel } = row;
    return {
      ...dbIngredientToTopLevelShape(row),
      product: mapIngredientProductsLean(
        productRel.map((product) => ({
          ...product,
          pricing: pricingById.get(product.id),
        })),
      ),
    };
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
export const enrichmentWorkbenchIngredients = async (
  db: Database,
  opts?: { restrictToIds?: IngredientId[] },
) => {
  // Recipe-scoped worklist (?recipe=<id>): an empty set means the recipe tree has
  // no leaf ingredients — return early rather than emit `IN ()`.
  if (opts?.restrictToIds && opts.restrictToIds.length === 0) return [];
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
      // Optional recipe scope: restrict to the leaf ingredients of one recipe's
      // sub-recipe tree (recipeTreeLeafIngredientIds).
      opts?.restrictToIds
        ? inArray(ingredient.id, opts.restrictToIds)
        : undefined,
    ),
    with: {
      product: {
        with: {
          unitMappings: true,
          externalIds: true,
          images: { orderBy: imageOrder, with: { image: true } },
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
  const pricedProducts = await enrichProductRowsWithPricing(
    db,
    rows.flatMap((row) => row.product),
  );
  const pricingById = new Map(
    pricedProducts.map((product) => [product.id, product.pricing]),
  );
  return rows.map((row) => {
    const { product: productRel, recipeCount, cookbookOnly } = row;
    return {
      ...dbIngredientToTopLevelShape(row),
      product: mapIngredientProducts(
        productRel.map((product) => ({
          ...product,
          pricing: pricingById.get(product.id),
        })),
      ),
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
  id: IngredientShortcode;
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
    columns: { id: true, shortcode: true, name: true, aliases: true },
  });

  // Index each row by its lowercased name + aliases, then assign every requested
  // name that matches. Aliases are returned so callers (e.g. instruction
  // highlighting) can recognize a matched ingredient by any of its names.
  const byKey = new Map<string, IngredientNameMatch>();
  for (const row of rows) {
    const match = {
      id: unsafeIngredientShortcode(row.shortcode),
      name: row.name,
      aliases: row.aliases,
    };
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
  filters: IngredientFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) => {
  const dbClient = getDb(db);

  // Ingredients with at least one live linked product. `product.ingredientId`
  // is a nullable FK, so `isNotNull` is load-bearing — a NULL inside a NOT IN
  // list makes the whole predicate UNKNOWN and "none" would match zero rows.
  const ingredientIdsWithLiveProducts = dbClient
    .select({ ingredientId: product.ingredientId })
    .from(product)
    .where(and(notDeleted(product), isNotNull(product.ingredientId)));

  // Ingredients used by at least one live recipe. Join-guarded at every level
  // (rsi, section, recipe) to match `liveRecipeCountForIngredientSql` exactly
  // (recipe/helpers.ts) — a looser predicate here would disagree with the
  // `appearsInRecipes` cell this same filter is supposed to partition on.
  const ingredientIdsInLiveRecipes = dbClient
    .select({ ingredientId: recipeSectionIngredient.ingredientId })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      and(
        eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
        notDeleted(recipeSection),
      ),
    )
    .innerJoin(
      recipe,
      and(eq(recipe.id, recipeSection.recipeId), notDeleted(recipe)),
    )
    .where(notDeleted(recipeSectionIngredient));

  // Always filter out deleted items and recipe ingredients
  const conditions: (SQL | undefined)[] = [
    isNull(ingredient.recipeId),
    notDeleted(ingredient),
    ...auditDateWhereConditions(ingredient, filters),
  ];

  // Add name filter if provided
  if (filters.nameFilter) {
    const nameCondition = buildIngredientWhere(false, filters.nameFilter);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  conditions.push(
    idSetPresence(
      ingredient.id,
      filters.productPresenceFilter,
      ingredientIdsWithLiveProducts,
    ),
    idSetPresence(
      ingredient.id,
      filters.recipePresenceFilter,
      ingredientIdsInLiveRecipes,
    ),
  );

  const whereClause = and(...conditions);

  // Build order by. `appearsInRecipes` and `product` are computed counts (not
  // real columns), so a resolver sorts them via correlated subqueries. These
  // MUST be written with sql.raw: the relational query builder
  // (query.ingredient.findMany) rewrites every column reference in a custom
  // orderBy to the root table's alias ("ingredient"), which mangles
  // cross-table refs. A raw string is opaque to that rewriter, so we
  // hand-qualify the inner tables and correlate to "ingredient"."id".
  // Everything else goes through the generic buildOrderBy column path.
  const resolveIngredientSort = (s: SortParams): SQL[] | null => {
    const dirSql = s.direction === "asc" ? "asc nulls last" : "desc nulls last";
    if (s.orderBy === "appearsInRecipes")
      return [
        // Shared with global search so the sort key matches the displayed
        // `appearsInRecipes.length` exactly (live recipes/sections/usages only).
        sql.raw(
          `${liveRecipeCountForIngredientSql('"ingredient"."id"')} ${dirSql}`,
        ),
      ];
    if (s.orderBy === "product")
      return [
        sql.raw(
          `(SELECT count(*) FROM "Product" p ` +
            `WHERE p."ingredientId" = "ingredient"."id" AND p."deletedAt" IS NULL) ${dirSql}`,
        ),
      ];
    return null;
  };
  const orderByClause = buildOrderBy(
    ingredient,
    sorts,
    [...ingredientSortableFields],
    { resolve: resolveIngredientSort },
  );

  const { take, skip } = buildTakeSkip(pagination);

  // Lean list shape: products (mapped) + a jsonb {id,name}[] of the recipes the
  // ingredient appears in (the list reads count = length, and the first ref for
  // the pill). Drops the per-usage Recipe + Section jsonb bodies the full graph
  // shipped — the list never reads them (that was the over-fetch).
  const leanRelations = {
    ...relations.ingredient.list,
    extras: {
      appearsInRecipes: sql<RecipeRef[]>`${sql.raw(
        appearsInRecipesRefsForIngredientSql('"ingredient"."id"'),
      )}`.as("appearsInRecipes"),
    },
  } as const;

  const { data: results, count: totalCount } = await executeListQueryWithCount(
    getDb(db).query.ingredient.findMany({
      where: whereClause,
      ...leanRelations,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
    }),
    countWhere(db, ingredient, whereClause),
  );

  const pricedProducts = await enrichProductRowsWithPricing(
    db,
    results.flatMap((row) => row.product),
  );
  const pricingById = new Map(
    pricedProducts.map((product) => [product.id, product.pricing]),
  );
  return {
    data: results.map((row) =>
      dbIngredientToListAPI({
        ...row,
        product: row.product.map((product) => ({
          ...product,
          pricing: pricingById.get(product.id),
        })),
      }),
    ),
    count: totalCount,
  };
};
