/**
 * Ingredient soft-delete with dependency guards.
 * Refuses to delete ingredients used in live recipes or linked to products,
 * locking the rows and logging the audit trail inside one transaction.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  product,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  buildCascadeAuditEntries,
  logAuditEntries,
} from "~/server/repo/audit-log";
import {
  assertNoDependents,
  lockAndValidateForDelete,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";

/**
 * Soft delete ingredients by setting deletedAt timestamp.
 * Throws if any ingredient is used in recipes or linked to products.
 */
export const deleteIngredients = async (
  db: Database,
  ids: IngredientId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  // Perform safety checks and soft delete in a transaction for atomicity
  await withTransaction(db, async (tx) => {
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
    const usedInRecipes = await tx
      .selectDistinct({ ingredientId: recipeSectionIngredient.ingredientId })
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
    const linkedProducts = await tx.query.product.findMany({
      where: and(inArray(product.ingredientId, ids), notDeleted(product)),
      columns: { ingredientId: true },
    });
    await assertNoDependents({
      offendingParentIds: linkedProducts.map((p) => p.ingredientId),
      fetchNames: fetchIngredientNames,
      reason: "INGREDIENT_HAS_PRODUCTS",
      message: (count, names) =>
        `Cannot delete ${count} ingredient(s): ${names} have linked products.`,
    });

    const now = new Date();

    await tx
      .update(ingredient)
      .set({ deletedAt: now })
      .where(inArray(ingredient.id, ids));

    // No cascaded items for ingredients — plain delete audit entries.
    const auditEntries = buildCascadeAuditEntries("ingredient", ids);

    await logAuditEntries(tx, actor, auditEntries);
  });
};
