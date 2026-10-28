import {
  type IngredientId,
  type IngredientShortcode,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import {
  rawIngredientDetail,
  rawIngredientList,
  rawIngredientOutput,
} from "@cubby/schemas/ingredient-raw-read";
import { rawProductWithMappings } from "@cubby/schemas/product-raw-read";
/**
 * Ingredient search, lookup, and the declared read.
 *
 * Name/alias matching for the merge suggester and cookbook importer, the
 * entity's list scaffold (its repository read port), the lean by-id batch
 * fetch for the costing path, and the enrichment-workbench worklist. None of
 * these mutate.
 */
import { type RecipeRef } from "@cubby/schemas/recipe";
import type { RawRecipeTopLevel as RecipeTopLevel } from "@cubby/schemas/recipe-shared";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { groupBy } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  buildSearchConditions,
  getDb,
  notDeleted,
  unwrapDb,
} from "~/server/db/helpers";
import { recipeSourceRelations } from "~/server/db/helpers/relations";
import {
  ingredient,
  product,
  productConversionCoverage,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { buildIngredientNutritionProduct } from "~/server/domains/ingredient/repo/nutrition-product";
import { ingredientSearch } from "~/server/domains/ingredient/repo/search-read-ingredient";
import { currentProductConversionCoverageCondition } from "~/server/domains/product/repo/conversion-coverage";
import { foodLookupParamFromProduct } from "~/server/domains/product/repo/helpers";
import {
  appearsInRecipesRefsForIngredientSql,
  computeRecipeUsages,
  cookbookOnlyForIngredientSql,
  dbRecipeToTopLevel,
  liveRecipeCountForIngredientSql,
  ownRecipeCountForIngredientSql,
} from "~/server/domains/recipe/repo/helpers";
import { batchEnrichWithFood } from "~/server/domains/usda-food/repo/usda-helpers";
import { loadIngredientRecipeEvidence } from "~/server/generic/field-explanation/repo/field-explanation-evidence";
import { listScaffold } from "~/server/generic/list/repo/list";
import { liveAliasSqlText } from "~/server/lib/live-row";

import { buildIngredientWhere } from "./internal-types";

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
        WHERE p."ingredientId" = "Ingredient"."id" AND ${notDeleted("p")}
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
        WHERE p."ingredientId" = "Ingredient"."id" AND ${notDeleted("p")}
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

/** Load costing ingredients through the declared read without recipe bodies. */
export const getIngredientsByIDsLean = async (
  db: Database,
  ids: IngredientId[],
) => {
  const projection = [...Object.keys(rawIngredientOutput.shape), "product"];
  const { data } = await ingredientScaffold.getByIds(db, ids, projection);
  return data.map((row) => ({
    ...rawIngredientOutput.parse(row),
    product: rawIngredientList.shape.product.parse(row.product),
  }));
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
 * the recipe-usages reader.
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
    columns: { id: true, shortcode: true },
    where: and(
      isNull(ingredient.recipeId),
      notDeleted(ingredient),
      sql.raw(`${recipeCountSql} > 0`),
      opts?.restrictToIds
        ? inArray(ingredient.id, opts.restrictToIds)
        : undefined,
    ),
    extras: {
      recipeCount: sql<number>`${sql.raw(recipeCountSql)}`.as("recipeCount"),
      cookbookOnly:
        sql<boolean>`${sql.raw(cookbookOnlyForIngredientSql(ref))}`.as(
          "cookbookOnly",
        ),
    },
    orderBy: [sql.raw(`${recipeCountSql} desc nulls last`)],
  });
  const records = await getIngredientsByIDsLean(
    db,
    rows.map((row) => row.id),
  );
  const byCode = new Map(records.map((record) => [record.id, record]));
  return rows.flatMap((row) => {
    const record = byCode.get(parseShortcodeFor("ingredient", row.shortcode));
    return record
      ? [
          {
            ...record,
            recipeCount: Number(row.recipeCount),
            cookbookOnly: row.cookbookOnly === true,
          },
        ]
      : [];
  });
};

/** The standalone ingredient named exactly (name or alias, any case), or null. */
export const findIngredientIdByName = async (
  db: Database,
  name: string,
): Promise<IngredientId | null> => {
  const [row] = await getDb(db)
    .select({ id: ingredient.id })
    .from(ingredient)
    .where(buildIngredientWhere(true, name))
    .limit(1);
  return row?.id ?? null;
};

/**
 * Batch counterpart to {@link findIngredientIdByName}: match many names in ONE
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

const qb = new QueryBuilder();

// Ingredients with at least one live linked product. `product.ingredientId`
// is a nullable FK, so `isNotNull` is load-bearing — a NULL inside a NOT IN
// list makes the whole predicate UNKNOWN and "none" would match zero rows.
const ingredientIdsWithLiveProducts = qb
  .select({ ingredientId: product.ingredientId })
  .from(product)
  .where(and(notDeleted(product), isNotNull(product.ingredientId)));

/**
 * Ingredients used by a live recipe, join-guarded at every level (rsi,
 * section, recipe) to match `liveRecipeCountForIngredientSql` exactly
 * (recipe/helpers.ts) — a looser predicate would disagree with the
 * `appearsInRecipes` cell the filter partitions on. `ownOnly` scopes to
 * recipes of your own as a SEPARATE subquery: scoping the shared one would
 * make `recipePresenceFilter` disagree with that cell and its sort.
 */
const ingredientIdsInLiveRecipes = (ownOnly: boolean) =>
  qb
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
        ownOnly ? isNull(recipe.cookbookId) : undefined,
      ),
    )
    .where(notDeleted(recipeSectionIngredient));

// Live products whose persisted conversion coverage is complete. A product
// with no current coverage row is unknown, so it does not close the gap. The
// isNotNull guard keeps NOT IN from going UNKNOWN on a NULL ingredientId.
const ingredientIdsWithCompleteProducts = qb
  .select({ ingredientId: product.ingredientId })
  .from(product)
  .innerJoin(
    productConversionCoverage,
    eq(productConversionCoverage.productId, product.id),
  )
  .where(
    and(
      notDeleted(product),
      isNotNull(product.ingredientId),
      currentProductConversionCoverageCondition(),
      eq(productConversionCoverage.coverageTier, "complete"),
    ),
  );

/** Each ingredient's live products, read through the Product scaffold. */
const loadIngredientProducts = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) => {
  const { kernelScaffold } = await import("~/server/entity-kernel/scaffolds");
  const productScaffold = kernelScaffold("product");
  if (!productScaffold) throw new Error("Product scaffold was not found");
  const links = await unwrapDb(db)
    .select({
      id: product.id,
      shortcode: product.shortcode,
      ingredientId: product.ingredientId,
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        inArray(
          product.ingredientId,
          ids.map((id) => parseEntityId("ingredient", id)),
        ),
      ),
    );
  const { data } = await productScaffold.getByIds(
    db,
    links.map((link) => link.id),
    Object.keys(rawProductWithMappings.shape),
  );
  const byCode = new Map(
    data.map((row) => {
      const record = rawProductWithMappings.parse(row);
      return [record.id, record] as const;
    }),
  );
  const byIngredient = groupBy(
    links,
    (link): string => link.ingredientId ?? "",
  );
  return new Map(
    ids.map((id) => [
      id,
      (byIngredient[id] ?? []).flatMap((link) => {
        const record = byCode.get(parseShortcodeFor("product", link.shortcode));
        return record ? [record] : [];
      }),
    ]),
  );
};

/** Each ingredient's live recipe-line usages, by ingredient id. */
const loadIngredientRecipeUsages = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) => {
  const rows = await unwrapDb(db).query.recipeSectionIngredient.findMany({
    where: and(
      inArray(
        recipeSectionIngredient.ingredientId,
        ids.map((id) => parseEntityId("ingredient", id)),
      ),
      notDeleted(recipeSectionIngredient),
    ),
    with: {
      recipeSection: {
        with: { recipe: { with: recipeSourceRelations } },
      },
    },
  });
  const byIngredient = groupBy(rows, (row): string => row.ingredientId ?? "");
  return new Map(
    ids.map((id) => [
      id,
      computeRecipeUsages(byIngredient[id] ?? []).recipeUsages,
    ]),
  );
};

/** The recipe a recipe-as-ingredient row stands for, while it is live. */
const loadIngredientRecipes = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) => {
  const rows = await unwrapDb(db).query.ingredient.findMany({
    where: inArray(
      ingredient.id,
      ids.map((id) => parseEntityId("ingredient", id)),
    ),
    columns: { id: true },
    with: { recipe: { with: recipeSourceRelations } },
  });
  return new Map<string, RecipeTopLevel | null>(
    rows.map((row) => [
      row.id,
      row.recipe && row.recipe.deletedAt === null
        ? dbRecipeToTopLevel(row.recipe)
        : null,
    ]),
  );
};

/**
 * The Ingredient read, stated once: list pages, selected projections and the
 * single-record read all select through it. The declared list scope keeps a
 * recipe's own ingredient rows out of pages.
 */
export const ingredientScaffold = listScaffold("ingredient", ingredient, {
  derived: {
    // Shared with global search so the sort key matches the displayed
    // `appearsInRecipes.length` exactly (live recipes/sections/usages only).
    appearsInRecipes: sql.raw(
      liveRecipeCountForIngredientSql('"Ingredient"."id"'),
    ),
    product: sql.raw(
      `(SELECT count(*) FROM "Product" p ` +
        `WHERE p."ingredientId" = "Ingredient"."id" AND ${liveAliasSqlText("p")})`,
    ),
    hasProduct: inArray(ingredient.id, ingredientIdsWithLiveProducts),
    inRecipes: inArray(ingredient.id, ingredientIdsInLiveRecipes(false)),
    ownRecipes: inArray(ingredient.id, ingredientIdsInLiveRecipes(true)),
    mappingGap: and(
      inArray(ingredient.id, ingredientIdsInLiveRecipes(false)),
      notInArray(ingredient.id, ingredientIdsWithCompleteProducts),
    )!,
  },
  read: {
    search: ingredientSearch,
    evidence: {
      recipeCount: loadIngredientRecipeEvidence,
      appearsInRecipes: loadIngredientRecipeEvidence,
    },
    columns: {
      // The derived `appearsInRecipes` is the count sorts and filters read;
      // the read key is the recipe refs themselves.
      appearsInRecipes: sql<RecipeRef[]>`${sql.raw(
        appearsInRecipesRefsForIngredientSql('"Ingredient"."id"'),
      )}`,
      // Distinct live NON-cookbook recipes — the number the
      // `ownRecipePresenceFilter` worklist selects on, so the card and the
      // filter can't report different populations.
      ownRecipeCount: sql<number>`(${sql.raw(
        ownRecipeCountForIngredientSql('"Ingredient"."id"'),
      )})::int`,
    },
    media: true,
    bindings: (bind) => {
      const products = bind.ids(({ db, ids }) =>
        loadIngredientProducts(db, ids),
      );
      const foods = bind.ids(async (page) => {
        const loaded = await products.load(page);
        // A read without the kernel's USDA client (a script) reads no foods.
        const port = page.context.reader.usdaClient ?? null;
        const linked = [...loaded.values()].flat();
        const enriched = port
          ? await batchEnrichWithFood(linked, foodLookupParamFromProduct, port)
          : linked.map((row) => ({ ...row, food: null }));
        const byId = new Map(enriched.map((row) => [row.id, row]));
        return new Map(
          [...loaded].map(([id, rows]) => [
            id,
            rows.map((row) => {
              const withFood = byId.get(row.id);
              if (!withFood)
                throw new Error("Ingredient product food was not loaded");
              return withFood;
            }),
          ]),
        );
      });
      const usages = bind.ids(({ db, ids }) =>
        loadIngredientRecipeUsages(db, ids),
      );
      const recipes = bind.ids(({ db, ids }) => loadIngredientRecipes(db, ids));
      return [
        products.fields(
          rawIngredientList.pick({ product: true }),
          (row, loaded) => ({ product: loaded.get(row.id) ?? [] }),
        ),
        // A record read carries each product's USDA food and the nutrition
        // basis chosen from them.
        foods.fields(
          rawIngredientDetail.pick({ product: true, nutritionProduct: true }),
          (row, loaded) => {
            const withFood = loaded.get(row.id) ?? [];
            return {
              product: withFood,
              nutritionProduct: buildIngredientNutritionProduct(withFood),
            };
          },
          { scope: "detail" },
        ),
        usages.fields(
          rawIngredientDetail.pick({ recipeUsages: true }),
          (row, loaded) => ({ recipeUsages: loaded.get(row.id) ?? [] }),
          { scope: "detail" },
        ),
        recipes.fields(
          rawIngredientDetail.pick({ recipe: true }),
          (row, loaded) => ({ recipe: loaded.get(row.id) ?? null }),
          { scope: "detail" },
        ),
      ];
    },
  },
});
