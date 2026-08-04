/**
 * Internal helpers + types shared across the ingredient repository modules.
 *
 * The deep DB row shape, the product/recipe-usage transforms, and the
 * case-insensitive name/alias `where` builder are consumed by both the CRUD and
 * search/list modules, so they live here rather than being duplicated. None of
 * these are re-exported from the package barrel.
 */

import type { DataQuality } from "@cubby/schemas/data-quality";
import {
  unsafeIngredientShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { IngredientOut } from "@cubby/schemas/ingredient";
import {
  type IngredientListItem,
  type IngredientWithRecipesAndProductOut,
  ingredientListItemOut,
} from "@cubby/schemas/ingredient";
import type { RecipeRef } from "@cubby/schemas/recipe";
import { and, inArray, isNull, or, sql } from "drizzle-orm";
import { parseWithContext } from "~/lib/zod-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  ingredient,
  type product,
  type productUnitMappings,
  type recipe,
  type recipeSection,
  type recipeSectionIngredient,
} from "~/server/db/schema";
import { enrichProductRowsWithDataQuality } from "~/server/repo/data-quality";
import {
  formatSearchTerm,
  type MappableImageRecord,
  mapRelation,
  notDeleted,
  type RowWithOptionalAliases,
} from "~/server/repo/database-helpers";
import type { MappableProductExternalId } from "~/server/repo/product/external-id-types";
import {
  dbProductToTopLevelAPI,
  dbProductToTopLevelShape,
  mapProductUnitMappings,
} from "~/server/repo/product/mappers";
import {
  enrichProductRowsWithPricing,
  type ProductPricing,
} from "~/server/repo/product/pricing";
import { computeRecipeUsages, dbRecipeToTopLevelShape } from "../recipe";

type IngredientSelect = typeof ingredient.$inferSelect;
type ProductSelect = RowWithOptionalAliases<typeof product.$inferSelect>;

export type IngredientDeepDB = typeof ingredient.$inferSelect & {
  product: Array<
    ProductSelect & {
      pricing?: ProductPricing;
      dataQuality?: DataQuality;
      unitMappings: Array<typeof productUnitMappings.$inferSelect>;
      externalIds: MappableProductExternalId[];
      images: Array<{
        image: MappableImageRecord;
        deletedAt?: Date | null;
      }>;
    }
  >;
  recipe: typeof recipe.$inferSelect | null;
  recipeSectionIngredient: Array<
    typeof recipeSectionIngredient.$inferSelect & {
      recipeSection: typeof recipeSection.$inferSelect & {
        recipe: typeof recipe.$inferSelect;
      };
    }
  >;
};

/**
 * A product row is only mappable to the API once it carries a *real* computed
 * DataQuality — `dbProductToTopLevelAPI`/`dbProductToTopLevelShape` have no
 * safe fallback for it (unlike `pricing`, whose empty-aggregate default is
 * safe), so every caller of {@link mapIngredientProducts} /
 * {@link mapIngredientProductsLean} must batch-load it first via
 * `enrichProductRowsWithDataQuality` / `loadProductDataQualities` and attach
 * it before calling in.
 */
export type Qualified<T> = T & { dataQuality: DataQuality };

/**
 * Shape an ingredient's joined product rows into the API product list: brand the
 * shortcode, lift images out of the join table, drop soft-deleted external ids,
 * and attach unit-mapping source metadata. Shared by the full ingredient
 * transform and the lean enrichment-workbench fetch so they can't drift.
 */
export const mapIngredientProducts = (
  productRel: Array<Qualified<IngredientDeepDB["product"][number]>>,
) =>
  mapRelation(productRel, (prod) => {
    const baseProduct = dbProductToTopLevelAPI(prod);
    return {
      ...baseProduct,
      unitMappings: mapProductUnitMappings(baseProduct.id, prod.unitMappings),
    };
  });

/** Product relation for the lean costing/getManyByIDs fetch: unit mappings only. */
type IngredientLeanDB = typeof ingredient.$inferSelect & {
  product: Array<
    ProductSelect & {
      pricing?: ProductPricing;
      unitMappings: Array<typeof productUnitMappings.$inferSelect>;
    }
  >;
};

export const dbIngredientToTopLevelShape = (
  ingredientData: IngredientSelect,
): IngredientOut => ({
  id: unsafeIngredientShortcode(ingredientData.shortcode),
  name: ingredientData.name,
  aliases: ingredientData.aliases,
  naKinds: ingredientData.naKinds,
  createdAt: ingredientData.createdAt,
  updatedAt: ingredientData.updatedAt,
});

type IngredientListDB = IngredientSelect & {
  product: Array<Qualified<IngredientDeepDB["product"][number]>>;
  appearsInRecipes: RecipeRef[] | null;
};

export const dbIngredientToListAPI = (
  ingredientData: IngredientListDB,
): IngredientListItem => {
  const result = {
    ...dbIngredientToTopLevelShape(ingredientData),
    product: mapIngredientProducts(ingredientData.product),
    appearsInRecipes: ingredientData.appearsInRecipes ?? [],
  };

  return parseWithContext(ingredientListItemOut, result, {
    entityType: "Ingredient",
    identifier: { id: ingredientData.id, name: ingredientData.name },
  });
};

/**
 * Lean product map: skips the `images` (full Image records) + `externalIds`
 * joins that costing / getManyByIDs never read. That over-fetch was ~4MB and
 * ~11s of drizzle object-building per call — pure worker CPU that blocked the
 * recompute-queue isolate's event loop while Postgres sat idle. Same shape as
 * {@link mapIngredientProducts} with the two unused relations emptied.
 */
export const mapIngredientProductsLean = (
  productRel: Array<Qualified<IngredientLeanDB["product"][number]>>,
) =>
  mapRelation(productRel, (prod) => {
    const baseProduct = dbProductToTopLevelShape(prod);
    return {
      ...baseProduct,
      unitMappings: mapProductUnitMappings(
        unsafeProductShortcode(prod.shortcode),
        prod.unitMappings,
      ),
    };
  });

export const dbIngredientToAPI = async (
  db: Database | DrizzleTransaction,
  ingredientData: IngredientDeepDB,
): Promise<IngredientWithRecipesAndProductOut> => {
  const {
    product: productRel,
    recipe: recipeRel,
    recipeSectionIngredient: recipeSectionIngredientRel,
  } = ingredientData;

  const pricedProductRel = productRel.every(
    (product) => product.pricing !== undefined,
  )
    ? productRel
    : await enrichProductRowsWithPricing(db, productRel);
  // Unconditional, unlike the `pricing` fast-path above: nothing upstream ever
  // pre-populates `dataQuality` (the raw relation doesn't select it, and
  // `enrichProductRowsWithPricing` only adds `pricing`), so an `.every(...)`
  // guard here would be true only for an empty array — and would carry a cast
  // that looks load-bearing while never actually proving anything. The enrich
  // call already no-ops on an empty list.
  const qualifiedProductRel = await enrichProductRowsWithDataQuality(
    db,
    pricedProductRel,
  );
  const productWithMappings = mapIngredientProducts(qualifiedProductRel);

  // One row per usage (a recipe repeats when it uses this ingredient in multiple
  // sections); the deduped `appearsInRecipes` is derived from these. Shared with
  // the product detail view via computeRecipeUsages.
  const { recipeUsages, appearsInRecipes } = computeRecipeUsages(
    recipeSectionIngredientRel ?? [],
  );

  return {
    ...dbIngredientToTopLevelShape(ingredientData),
    recipe:
      recipeRel && recipeRel.deletedAt === null
        ? dbRecipeToTopLevelShape(recipeRel)
        : null,
    product: productWithMappings,
    recipeUsages,
    appearsInRecipes,
  };
};

// Case-insensitive alias match: compare lower(each alias) against the lowercased
// list. Plain `arrayOverlaps` is case-sensitive, which would disagree with the
// case-insensitive name match (and the lower(name) unique index) — e.g. an alias
// "Scallion" wouldn't match a "scallion" lookup.
const aliasMatchesCaseInsensitive = (list: string[]) => {
  const lowered = list.map((n) => n.toLowerCase());
  return sql`EXISTS (SELECT 1 FROM unnest(${ingredient.aliases}) AS t(val) WHERE lower(t.val) IN (${sql.join(
    lowered.map((v) => sql`${v}`),
    sql`, `,
  )}))`;
};

// exact:
//  true -> case-insensitive match on name or aliases
//  false -> search on name, case-insensitive match on aliases
export const buildIngredientWhere = (
  exact: boolean,
  name: string,
  otherSearchNames?: string[],
) => {
  const list = [name, ...(otherSearchNames ?? [])];

  const conditions = [];

  // Name or aliases condition
  if (exact) {
    // Exact (case-insensitive) match: lower(name) IN list OR any alias matches
    conditions.push(
      or(
        inArray(
          sql`lower(${ingredient.name})`,
          list.map((n) => n.toLowerCase()),
        ),
        aliasMatchesCaseInsensitive(list),
      ),
    );
  } else {
    // Search on name (ilike), case-insensitive match on aliases
    conditions.push(
      or(
        formatSearchTerm(ingredient.name, name),
        aliasMatchesCaseInsensitive(list),
      ),
    );
  }

  // Filter for standalone ingredients only, not recipe ingredients
  conditions.push(isNull(ingredient.recipeId));

  // Filter out deleted items
  conditions.push(notDeleted(ingredient));

  return and(...conditions);
};
