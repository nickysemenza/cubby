/**
 * Ingredient soft-delete with dependency guards.
 * Refuses to delete ingredients retained by live recipes, products, meal food
 * entries, inside one locked transaction; plant links are cleared.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { IngredientId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  ingredient,
  mealFoodEntry,
  plant,
  product,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  assertNoDependents,
  lockAndValidateForDelete,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { removeEntity } from "~/server/repo/removal";

export const INGREDIENT_DELETE_EDGE_POLICY = {
  "MealFoodEntry.ingredientId": {
    code: "block-live-meal-food-entry",
    effect: "block",
    description:
      "An ingredient recorded in a live meal food entry cannot be deleted.",
  },
  "RecipeSectionIngredient.ingredientId": {
    code: "block-live-recipe-usage",
    effect: "block",
    description:
      "An ingredient still used in a live recipe can't be deleted — remove it from every recipe first.",
  },
  "Product.ingredientId": {
    code: "block-live-product",
    effect: "block",
    description:
      "An ingredient linked to a product can't be deleted — unlink or delete the product first.",
  },
  "Plant.ingredientId": {
    code: "clearFk",
    effect: "detach",
    description:
      "A plant's ingredient link is informational; deleting the ingredient clears it.",
  },
} as const satisfies IncomingEdgePolicy<"ingredient", OperationDisposition>;

/**
 * Live recipe-line usages of the given ingredients — joined through section
 * and recipe so a usage whose parent recipe/section is soft-deleted doesn't
 * count. Must filter all three join levels (usage → section → recipe) so an
 * ingredient whose only usages live in soft-deleted recipes doesn't block
 * deletion — this matches `liveRecipeCountForIngredientSql`'s liveness
 * semantics, so the guard and the displayed recipe count never disagree.
 *
 * Used by `deleteIngredients`, which refuses when any exist.
 */
const findLiveRecipeUsagesOfIngredients = (
  db: Database | DrizzleTransaction,
  ids: IngredientId[],
) =>
  unwrapDb(db)
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
    .where(
      and(
        inArray(recipeSectionIngredient.ingredientId, ids),
        notDeleted(recipeSectionIngredient),
      ),
    );

/**
 * Live products linked to the given ingredients. Used by `deleteIngredients`,
 * which refuses when any exist.
 */
const findLiveProductsLinkedToIngredients = (
  db: Database | DrizzleTransaction,
  ids: IngredientId[],
) =>
  unwrapDb(db).query.product.findMany({
    where: and(inArray(product.ingredientId, ids), notDeleted(product)),
    columns: { ingredientId: true },
  });

const findLiveMealFoodEntriesForIngredients = (
  db: Database | DrizzleTransaction,
  ids: IngredientId[],
) =>
  unwrapDb(db).query.mealFoodEntry.findMany({
    where: and(
      inArray(mealFoodEntry.ingredientId, ids),
      notDeleted(mealFoodEntry),
    ),
    columns: { ingredientId: true },
  });

/**
 * Soft delete ingredients by setting deletedAt timestamp.
 * Throws if any ingredient is used in recipes or linked to products.
 */
export const deleteIngredients = async (
  db: Database,
  ids: IngredientId[],
  actor: ActorContext,
): Promise<{ deleted: number }> => {
  if (ids.length === 0) return { deleted: 0 };

  // Perform safety checks and soft delete in a transaction for atomicity
  return await withTransaction(db, async (tx) => {
    // Lock ingredients and validate they exist and aren't already deleted
    // Prevents race conditions by acquiring row-level locks
    await lockAndValidateForDelete(tx, ingredient, ids, "Ingredient");

    // Safety check: don't delete if any are used in *live* recipes. Must filter
    // all three join levels (usage → section → recipe) so an ingredient whose
    // only usages live in soft-deleted recipes doesn't block deletion — this
    // matches the liveness semantics of `liveRecipeCountForIngredientSql` used by
    // the read surfaces, so the guard and the displayed recipe count never
    // disagree. A shallow `notDeleted(rsi)`-only check trips on orphaned usage
    // rows whose parent recipe was soft-deleted (legacy/out-of-band rows).
    const usedInRecipes = await findLiveRecipeUsagesOfIngredients(tx, ids);
    const fetchIngredientNames = (failedIds: IngredientId[]) =>
      tx.query.ingredient.findMany({
        where: inArray(ingredient.id, failedIds),
        columns: { name: true },
      });
    await assertNoDependents({
      offendingParentIds: usedInRecipes.map((r) => r.ingredientId),
      fetchNames: fetchIngredientNames,
      reason: "INGREDIENT_HAS_RECIPES",
      message: (count, names) =>
        `Cannot delete ${count} ingredient(s): ${names} are used in recipes.`,
    });

    // Safety check: don't delete if any are linked to products
    const linkedProducts = await findLiveProductsLinkedToIngredients(tx, ids);
    await assertNoDependents({
      offendingParentIds: linkedProducts.map((p) => p.ingredientId),
      fetchNames: fetchIngredientNames,
      reason: "INGREDIENT_HAS_PRODUCTS",
      message: (count, names) =>
        `Cannot delete ${count} ingredient(s): ${names} have linked products.`,
    });

    const mealFoodEntries = await findLiveMealFoodEntriesForIngredients(
      tx,
      ids,
    );
    await assertNoDependents({
      offendingParentIds: mealFoodEntries.flatMap((entry) =>
        entry.ingredientId ? [entry.ingredientId] : [],
      ),
      fetchNames: fetchIngredientNames,
      reason: "INGREDIENT_HAS_MEAL_FOOD_ENTRIES",
      message: (count, names) =>
        `Cannot delete ${count} ingredient(s): ${names} are recorded in meal food entries.`,
    });

    // "Plant.ingredientId" is `detach`: the link is informational only.
    await tx
      .update(plant)
      .set({ ingredientId: null })
      .where(inArray(plant.ingredientId, ids));

    // No `children`: an ingredient delete has no cascaded child rows.
    const { deleted } = await removeEntity(tx, {
      entity: "ingredient",
      ids,
      removal: "soft",
      actor,
    });
    return { deleted };
  });
};
