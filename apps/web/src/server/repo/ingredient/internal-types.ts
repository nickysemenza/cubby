/**
 * Internal helpers + types shared across the ingredient repository modules.
 *
 * The deep DB row shape, the product/recipe-usage transforms, and the
 * case-insensitive name/alias `where` builder are consumed by both the CRUD and
 * search/list modules, so they live here rather than being duplicated. None of
 * these are re-exported from the package barrel.
 */

import type { IngredientWithRecipesAndProductOut } from "@cubby/schemas/ingredient-responses";
import { and, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type image,
  ingredient,
  type product,
  type productExternalId,
  type productUnitMappings,
  type recipe,
  type recipeSection,
  type recipeSectionIngredient,
} from "~/server/db/schema";
import {
  formatSearchTerm,
  mapRelation,
  notDeleted,
} from "~/server/repo/database-helpers";
import {
  dbProductToTopLevelAPI,
  dbProductToTopLevelShape,
  mapProductUnitMappings,
} from "~/server/repo/product/mappers";
import { computeRecipeUsages, dbRecipeToAPIShallow } from "../recipe";

export type IngredientDeepDB = typeof ingredient.$inferSelect & {
  product: Array<
    typeof product.$inferSelect & {
      unitMappings: Array<typeof productUnitMappings.$inferSelect>;
      externalIds: Array<typeof productExternalId.$inferSelect>;
      images: Array<{
        image: typeof image.$inferSelect;
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
 * Shape an ingredient's joined product rows into the API product list: brand the
 * shortcode, lift images out of the join table, drop soft-deleted external ids,
 * and attach unit-mapping source metadata. Shared by the full ingredient
 * transform and the lean enrichment-workbench fetch so they can't drift.
 */
export const mapIngredientProducts = (
  productRel: IngredientDeepDB["product"],
) =>
  mapRelation(productRel, (prod) => {
    const baseProduct = dbProductToTopLevelAPI(prod);
    return {
      ...baseProduct,
      unitMappings: mapProductUnitMappings(prod.id, prod.unitMappings),
    };
  });

/** Product relation for the lean costing/getManyByIDs fetch: unit mappings only. */
type IngredientLeanDB = typeof ingredient.$inferSelect & {
  product: Array<
    typeof product.$inferSelect & {
      unitMappings: Array<typeof productUnitMappings.$inferSelect>;
    }
  >;
};

/**
 * Lean product map: skips the `images` (full Image records) + `externalIds`
 * joins that costing / getManyByIDs never read. That over-fetch was ~4MB and
 * ~11s of drizzle object-building per call — pure worker CPU that blocked the
 * recompute-queue isolate's event loop while Postgres sat idle. Same shape as
 * {@link mapIngredientProducts} with the two unused relations emptied.
 */
export const mapIngredientProductsLean = (
  productRel: IngredientLeanDB["product"],
) =>
  mapRelation(productRel, (prod) => {
    const baseProduct = dbProductToTopLevelShape(prod);
    return {
      ...baseProduct,
      unitMappings: mapProductUnitMappings(prod.id, prod.unitMappings),
    };
  });

export const dbIngredientToAPI = async (
  _db: Database | DrizzleTransaction,
  ingredientData: IngredientDeepDB,
): Promise<IngredientWithRecipesAndProductOut> => {
  const {
    product: productRel,
    recipe: recipeRel,
    recipeSectionIngredient: recipeSectionIngredientRel,
    ...restOfIngredient
  } = ingredientData;

  const productWithMappings = mapIngredientProducts(productRel);

  // One row per usage (a recipe repeats when it uses this ingredient in multiple
  // sections); the deduped `appearsInRecipes` is derived from these. Shared with
  // the product detail view via computeRecipeUsages.
  const { recipeUsages, appearsInRecipes } = computeRecipeUsages(
    recipeSectionIngredientRel ?? [],
  );

  return {
    ...restOfIngredient,
    id: restOfIngredient.id,
    recipe: recipeRel ? dbRecipeToAPIShallow(recipeRel) : null,
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
