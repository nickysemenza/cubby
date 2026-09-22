import {
  type IngredientId,
  type IngredientShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type {
  IngredientFilters,
  IngredientListItem,
  IngredientMergeCandidateImpact,
} from "@cubby/schemas/ingredient";
/**
 * Ingredient search, lookup, and list reads.
 *
 * Name/alias matching for the merge suggester and cookbook importer, the
 * paginated list with its computed sort keys, the lean by-id batch fetch for the
 * costing path, and the enrichment-workbench worklist. None of these mutate.
 */
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
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
  enrichProductRowsWithDataQuality,
  loadProductDataQualities,
} from "~/server/repo/data-quality";
import {
  auditDateWhereConditions,
  buildSearchConditions,
  countWhere,
  executeListQueryWithCount,
  getDb,
  idSetPresence,
  imageOrder,
  type ListReadIntent,
  notDeleted,
  relations,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { listScaffold } from "~/server/repo/list-scaffold";
import {
  enrichProductRowsWithPricing,
  loadProductPricingForIngredientIds,
} from "~/server/repo/product/pricing";
import { relatedWhereConditions } from "~/server/repo/related-view";

import { categorySummarySql } from "../product-category-sql";
import { productClassificationEvidenceSql } from "../product/classification-evidence";
import {
  appearsInRecipesRefsForIngredientSql,
  computeRecipeUsages,
  cookbookOnlyForIngredientSql,
  liveRecipeCountForIngredientSql,
  ownRecipeCountForIngredientSql,
} from "../recipe";
import { buildIngredientWhere } from "./internal-types";
import {
  dbIngredientToAPI,
  dbIngredientToListAPI,
  dbIngredientToTopLevel,
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
      buildSearchConditions(
        ingredient,
        [{ column: ingredient.name, term: query }],
        [isNull(ingredient.recipeId), ne(ingredient.id, excludeId)],
      ),
    )
    .limit(limit);
  return rows.map((r) => ({ ...r, productCount: Number(r.productCount) }));
};

/**
 * Fetch specific ingredients by id for the AI merge suggester's semantic
 * shortlist leg — semantic search returns entity ids (not a name to search
 * on), so this is a by-id counterpart to {@link searchIngredientsForMerge}
 * with the same lean projection and productCount subquery.
 */
export const getIngredientMergeCandidatesByIds = async (
  db: Database,
  ids: IngredientId[],
  excludeId: IngredientId,
): Promise<
  {
    id: IngredientId;
    shortcode: string;
    name: string;
    productCount: number;
  }[]
> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db)
    .select({
      id: ingredient.id,
      shortcode: ingredient.shortcode,
      name: ingredient.name,
      // ⚠️ `"Ingredient"."id"` hand-qualified verbatim from
      // `searchIngredientsForMerge` above — see its comment for why an
      // interpolated `${ingredient.id}` silently self-joins instead.
      productCount: sql<number>`(
        SELECT count(*) FROM "Product" p
        WHERE p."ingredientId" = "Ingredient"."id" AND p."deletedAt" IS NULL
      )`,
    })
    .from(ingredient)
    .where(
      and(
        inArray(ingredient.id, ids),
        isNull(ingredient.recipeId),
        ne(ingredient.id, excludeId),
        notDeleted(ingredient),
      ),
    );
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
      // Mirrors `foodLookupParamFromProduct`: an explicit fdc_id, else a
      // barcode — OR a label nutrition override, which supersedes USDA
      // outright. `sql.raw` with the outer reference hand-qualified — this is
      // a joined-through aggregate over a single-table select, where drizzle
      // strips the table prefix off an interpolated column and the subquery
      // would silently self-join.
      hasUsdaLink: sql<boolean>`bool_or(${product.fdc_id} is not null or ${product.labelNutrition} is not null or ${sql.raw(
        `EXISTS (SELECT 1 FROM "ProductExternalId" pei WHERE pei."productId" = "Product"."id" AND pei."source" = 'gtin' AND pei."deletedAt" IS NULL)`,
      )})`,
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
      id: parseShortcodeFor("ingredient", b.shortcode),
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
  const [rows, pricingById] = await Promise.all([
    getDb(db).query.ingredient.findMany({
      where: and(inArray(ingredient.id, ids), notDeleted(ingredient)),
      // Unit mappings only — NOT images/externalIds. Costing + getManyByIDs never
      // read them, and pulling full Image records here was ~4MB + ~11s of drizzle
      // object-building per call (worker CPU that starved the recompute isolate).
      with: {
        product: {
          where: notDeleted(product),
          extras: {
            category: categorySummarySql(sql`${product.categoryId}`).as(
              "category",
            ),
            classificationEvidence: productClassificationEvidenceSql(
              sql`${product.id}`,
            ).as("classificationEvidence"),
          },
          with: { unitMappings: true },
        },
      },
    }),
    // This is still one batched GROUP BY, but it no longer serializes behind
    // drizzle's Product relation object-building. Product_ingredientId_idx and
    // Expense_productId_idx cover the two join keys.
    loadProductPricingForIngredientIds(db, ids),
  ]);
  const qualityById = await loadProductDataQualities(
    db,
    rows.flatMap((row) => row.product.map((product) => product.id)),
  );
  return rows.map((row) => {
    const { product: productRel } = row;
    return {
      ...dbIngredientToTopLevel(row),
      product: mapIngredientProductsLean(
        productRel.map((product) => ({
          ...product,
          pricing: pricingById.get(product.id),
          dataQuality: qualityById.get(product.id)!,
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
        extras: {
          category: categorySummarySql(sql`${product.categoryId}`).as(
            "category",
          ),
          classificationEvidence: productClassificationEvidenceSql(
            sql`${product.id}`,
          ).as("classificationEvidence"),
        },
        where: notDeleted(product),
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
  const qualifiedProducts = await enrichProductRowsWithDataQuality(
    db,
    rows.flatMap((row) => row.product),
  );
  const qualityById = new Map(
    qualifiedProducts.map((product) => [product.id, product.dataQuality]),
  );
  return rows.map((row) => {
    const { product: productRel, recipeCount, cookbookOnly } = row;
    return {
      ...dbIngredientToTopLevel(row),
      product: mapIngredientProducts(
        productRel.map((product) => ({
          ...product,
          pricing: pricingById.get(product.id),
          dataQuality: qualityById.get(product.id)!,
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
      id: parseShortcodeFor("ingredient", row.shortcode),
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

const ingredientScaffold = listScaffold("ingredient", ingredient);

/**
 * The complete WHERE for an ingredient list. `getEntityCounts` calls it with
 * `{}` — see repo/dashboard.ts.
 *
 * Named `...ListWhere` rather than `buildIngredientWhere`: that name is already
 * taken by the name-matching helper in ingredient/internal-types.ts.
 */
export const buildIngredientListWhere = async (
  db: Database,
  filters: IngredientFilters,
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

  // The same three-level guarded shape as `ingredientIdsInLiveRecipes`, scoped
  // to recipes of your own. A SEPARATE subquery on purpose: scoping the one
  // above would make `recipePresenceFilter` disagree with the
  // `appearsInRecipes` cell and sort beside it, which count every live recipe —
  // exactly the divergence that subquery's own comment forbids.
  const ingredientIdsInOwnRecipes = dbClient
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
      and(
        eq(recipe.id, recipeSection.recipeId),
        notDeleted(recipe),
        isNull(recipe.cookbookId),
      ),
    )
    .where(notDeleted(recipeSectionIngredient));

  // Always filter out recipe-scoped ingredients; `notDeleted` is folded into
  // `ingredientScaffold.where` below.
  const computed: Array<SQL | undefined> = [
    isNull(ingredient.recipeId),
    ...auditDateWhereConditions(ingredient, filters),
  ];

  // Add name filter if provided
  if (filters.nameFilter) {
    const nameCondition = buildIngredientWhere(false, filters.nameFilter);
    if (nameCondition) {
      computed.push(nameCondition);
    }
  }

  // `usuallyOnHand` is a declared stored filter, folded into
  // `ingredientScaffold.where` below. `nameFilter` above stays hand-written —
  // it ORs the alias match in, which the standard text shape can't express —
  // and the presence filters below stay hand-written too, since their
  // descriptors aren't `deriveSchema: true` and resolve against a correlated
  // id-set subquery, not a real column.
  computed.push(
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
    idSetPresence(
      ingredient.id,
      filters.ownRecipePresenceFilter,
      ingredientIdsInOwnRecipes,
    ),
    ...relatedWhereConditions("ingredient", filters, ingredient.id),
  );

  const whereClause = ingredientScaffold.where(filters, computed);
  return whereClause;
};

const ingredientListImpl = async (
  db: Database,
  filters: IngredientFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) => {
  const dbClient = getDb(db);
  const whereClause = await buildIngredientListWhere(db, filters);

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
  const orderByClause = ingredientScaffold.orderBy(
    sorts,
    {
      resolve: resolveIngredientSort,
    },
    filters,
  );

  const { take, skip } = ingredientScaffold.page(pagination);

  if (readIntent === "ids") {
    // Routed through the relational builder, not a plain `.select().from()`,
    // so `orderByClause` resolves against the same `"ingredient"` alias a
    // resolver sort hand-qualifies (see `resolveIngredientSort` above) — a
    // plain select has no alias, so a resolver sort would throw
    // `missing FROM-clause entry for table "ingredient"`.
    const rows = await dbClient.query.ingredient.findMany({
      columns: { shortcode: true },
      where: whereClause,
      orderBy: orderByClause,
      // One look-ahead row tells the bulk scan whether another page exists,
      // avoiding a count query it would otherwise discard.
      limit: take + 1,
      offset: skip,
    });
    const data = rows.map((row) => ({ id: row.shortcode }));
    return { data: data.slice(0, take), hasMore: data.length > take };
  }

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
      // Distinct live NON-cookbook recipes — the number the
      // `ownRecipePresenceFilter` worklist selects on, so the card and the
      // filter can't report different populations.
      ownRecipeCount: sql<number>`${sql.raw(
        ownRecipeCountForIngredientSql('"ingredient"."id"'),
      )}`.as("ownRecipeCount"),
    },
  } as const;

  const { data: results, count: totalCount } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      getDb(db).query.ingredient.findMany({
        where: whereClause,
        ...leanRelations,
        orderBy: orderByClause,
        limit: take,
        offset: skip,
      }),
    count: () => countWhere(db, ingredient, whereClause),
  });
  if (readIntent === "count") {
    return { data: [], count: totalCount };
  }

  const pricedProducts = await enrichProductRowsWithPricing(
    db,
    results.flatMap((row) => row.product),
  );
  const pricingById = new Map(
    pricedProducts.map((product) => [product.id, product.pricing]),
  );
  const qualifiedProducts = await enrichProductRowsWithDataQuality(
    db,
    results.flatMap((row) => row.product),
  );
  const qualityById = new Map(
    qualifiedProducts.map((product) => [product.id, product.dataQuality]),
  );
  return {
    data: await withDisplayImages(
      db,
      "ingredient",
      results,
      (row, displayImages) =>
        dbIngredientToListAPI(
          {
            ...row,
            product: row.product.map((product) => ({
              ...product,
              pricing: pricingById.get(product.id),
              dataQuality: qualityById.get(product.id)!,
            })),
          },
          displayImages,
        ),
    ),
    count: totalCount,
  };
};

export function ingredientList(
  db: Database,
  filters: IngredientFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: "ids",
): Promise<{ data: { id: IngredientShortcode }[]; hasMore: boolean }>;
export function ingredientList(
  db: Database,
  filters: IngredientFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent?: Exclude<ListReadIntent, "ids">,
): Promise<{ data: IngredientListItem[]; count: number }>;
export function ingredientList(
  db: Database,
  filters: IngredientFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) {
  return ingredientListImpl(db, filters, sorts, pagination, readIntent);
}
