import type { ActorContext } from "@cubby/schemas/context";
import {
  mealFoodMutationOut,
  type MealNutritionInput,
  type SaveMealFoodInput,
  type removeMealFoodInput,
} from "@cubby/schemas/meal";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "~/server/db";
import {
  meal,
  mealFoodEntry,
  mealRecipe,
  mealRecipePortion,
  ledgerParty,
  product,
  ingredient,
  recipe,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { lockLedgerPartiesForReference } from "~/server/repo/ledger-party-reference";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

export const saveMealFood = (
  db: Database,
  input: SaveMealFoodInput,
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const [eater] = await lockLedgerPartiesForReference(tx, [
      input.ledgerPartyId,
    ]);
    if (!eater || eater.kind === "household")
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Choose a member or guest as the eater.",
      );
    const mealId = await resolveOrThrow(tx, "meal", input.mealId);
    const [target] = await tx
      .select({ id: meal.id })
      .from(meal)
      .where(and(eq(meal.id, mealId), notDeleted(meal)))
      .for("key share");
    if (!target) throw createAppError("MEAL_NOT_FOUND", "Meal not found");
    const productId =
      input.sourceKind === "product"
        ? await resolveOrThrow(tx, "product", input.productId)
        : null;
    if (productId) {
      const [source] = await tx
        .select({ id: product.id })
        .from(product)
        .where(and(eq(product.id, productId), notDeleted(product)))
        .for("key share");
      if (!source)
        throw createAppError("PRODUCT_NOT_FOUND", "Product not found");
    }
    const ingredientId =
      input.sourceKind === "ingredient"
        ? await resolveOrThrow(tx, "ingredient", input.ingredientId)
        : null;
    if (ingredientId) {
      const [source] = await tx
        .select({ id: ingredient.id, recipeId: ingredient.recipeId })
        .from(ingredient)
        .where(and(eq(ingredient.id, ingredientId), notDeleted(ingredient)))
        .for("key share");
      if (!source)
        throw createAppError("INGREDIENT_NOT_FOUND", "Ingredient not found");
      if (source.recipeId)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Use a recipe portion for this ingredient.",
        );
    }
    const values = {
      mealId,
      ledgerPartyId: eater.id,
      productId,
      ingredientId,
      sourceKind: input.sourceKind,
      amount: input.amount ?? null,
      name: input.sourceKind === "manual" ? input.name : null,
      nutrients: input.sourceKind === "manual" ? input.nutrients : null,
    };
    const rows = input.id
      ? await tx
          .update(mealFoodEntry)
          .set(values)
          .where(
            and(
              eq(mealFoodEntry.id, input.id),
              eq(mealFoodEntry.mealId, mealId),
              notDeleted(mealFoodEntry),
            ),
          )
          .returning({ id: mealFoodEntry.id })
      : await tx
          .insert(mealFoodEntry)
          .values(values)
          .returning({ id: mealFoodEntry.id });
    const saved = rows[0];
    if (!saved)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "This food entry is no longer available. Refresh the meal.",
      );
    await logAuditEntry(tx, actor, {
      entityType: "meal",
      entityId: mealId,
      action: "update",
    });
    return mealFoodMutationOut.parse({ mealId: input.mealId, id: saved.id });
  });

export const removeMealFood = (
  db: Database,
  input: typeof removeMealFoodInput._output,
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const mealId = await resolveOrThrow(tx, "meal", input.mealId);
    const [removed] = await tx
      .update(mealFoodEntry)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(mealFoodEntry.id, input.id),
          eq(mealFoodEntry.mealId, mealId),
          notDeleted(mealFoodEntry),
        ),
      )
      .returning({ id: mealFoodEntry.id });
    if (!removed)
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "This food entry is no longer available. Refresh the meal.",
      );
    await logAuditEntry(tx, actor, {
      entityType: "meal",
      entityId: mealId,
      action: "update",
    });
    return mealFoodMutationOut.parse({ mealId: input.mealId, id: removed.id });
  });

/** Load only target portions; preparing a dish never contributes intake by itself. */
export async function getMealNutritionRows(
  db: Database,
  input: MealNutritionInput,
) {
  const mealId =
    "mealId" in input ? await resolveOrThrow(db, "meal", input.mealId) : null;
  const meals = await getDb(db)
    .select({
      id: meal.id,
      shortcode: meal.shortcode,
      date: meal.date,
      name: meal.name,
      mealType: meal.mealType,
    })
    .from(meal)
    .where(
      and(
        notDeleted(meal),
        "date" in input ? eq(meal.date, input.date) : eq(meal.id, mealId!),
      ),
    )
    .orderBy(meal.date, meal.sortOrder, meal.createdAt);
  const ids = meals.map((row) => row.id);
  const sourceMeal = alias(meal, "NutritionSourceMeal");
  const [portions, foods] = ids.length
    ? await Promise.all([
        getDb(db)
          .select({
            mealId: mealRecipePortion.mealId,
            eaterId: ledgerParty.shortcode,
            eaterName: ledgerParty.name,
            amount: mealRecipePortion.amount,
            mealRecipeId: mealRecipe.id,
            sourceMealId: sourceMeal.shortcode,
            recipeId: recipe.shortcode,
            name: recipe.name,
            recipeTotals: recipe.totals,
            totalsComputedAt: recipe.totalsComputedAt,
            recipeYield: recipe.yield,
            recipeServings: recipe.servings,
            scale: mealRecipe.scale,
            actualYieldGrams: mealRecipe.actualYieldGrams,
            estimatedYieldGrams: mealRecipe.estimatedYieldGrams,
          })
          .from(mealRecipePortion)
          .innerJoin(
            mealRecipe,
            and(
              eq(mealRecipePortion.mealRecipeId, mealRecipe.id),
              notDeleted(mealRecipe),
            ),
          )
          .innerJoin(
            sourceMeal,
            and(eq(mealRecipe.mealId, sourceMeal.id), notDeleted(sourceMeal)),
          )
          .innerJoin(
            recipe,
            and(eq(mealRecipe.recipeId, recipe.id), notDeleted(recipe)),
          )
          .innerJoin(
            ledgerParty,
            and(
              eq(mealRecipePortion.ledgerPartyId, ledgerParty.id),
              notDeleted(ledgerParty),
            ),
          )
          .where(
            and(
              inArray(mealRecipePortion.mealId, ids),
              notDeleted(mealRecipePortion),
            ),
          )
          .orderBy(mealRecipe.sortOrder, mealRecipePortion.createdAt),
        getDb(db)
          .select({
            entry: mealFoodEntry,
            eaterId: ledgerParty.shortcode,
            eaterName: ledgerParty.name,
            productId: product.shortcode,
            productName: product.name,
            productDeletedAt: product.deletedAt,
            ingredientId: ingredient.shortcode,
            ingredientName: ingredient.name,
            ingredientDeletedAt: ingredient.deletedAt,
          })
          .from(mealFoodEntry)
          .innerJoin(
            ledgerParty,
            and(
              eq(mealFoodEntry.ledgerPartyId, ledgerParty.id),
              notDeleted(ledgerParty),
            ),
          )
          // includes-deleted: a corrupted out-of-band Product deletion must not
          // erase the recorded food amount from the eater's nutrition history.
          .leftJoin(product, eq(mealFoodEntry.productId, product.id))
          // includes-deleted: preserve the entered amount after an out-of-band source deletion.
          .leftJoin(ingredient, eq(mealFoodEntry.ingredientId, ingredient.id))
          .where(
            and(inArray(mealFoodEntry.mealId, ids), notDeleted(mealFoodEntry)),
          )
          .orderBy(mealFoodEntry.createdAt),
      ])
    : [[], []];
  return { meals, portions, foods };
}
