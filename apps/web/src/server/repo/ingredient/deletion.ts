/**
 * Ingredient soft-delete with dependency guards.
 * The declared policy refuses live products and meal food entries and clears
 * plant links; only recipe usage needs its own three-level liveness guard.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { IngredientId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  assertNoDependents,
  notDeleted,
  unwrapDb,
} from "~/server/repo/database-helpers";
import { deleteByPolicy } from "~/server/repo/removal";

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
 * An orphaned usage row under a deleted recipe therefore never blocks.
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

const refuseLiveRecipeUsage = async (
  tx: DrizzleTransaction,
  ids: IngredientId[],
) => {
  const used = await findLiveRecipeUsagesOfIngredients(tx, ids);
  await assertNoDependents({
    offendingParentIds: used.map((row) => row.ingredientId),
    fetchNames: (failedIds: IngredientId[]) =>
      tx.query.ingredient.findMany({
        where: inArray(ingredient.id, failedIds),
        columns: { name: true },
      }),
    reason: "INGREDIENT_HAS_RECIPES",
    message: (count, names) =>
      `Cannot delete ${count} ingredient(s): ${names} are used in recipes.`,
  });
};

/** Ingredient deletes take uuids: the adapter and the problems sweep hold them. */
export const deleteIngredients = (
  db: Database,
  ids: IngredientId[],
  actor: ActorContext,
) =>
  deleteByPolicy(db, {
    entity: "ingredient",
    policy: INGREDIENT_DELETE_EDGE_POLICY,
    ids,
    actor,
    overrides: {
      "RecipeSectionIngredient.ingredientId": refuseLiveRecipeUsage,
    },
  });
