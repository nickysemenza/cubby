/**
 * Ingredient soft-delete with dependency guards.
 * Refuses to delete ingredients used in live recipes or linked to products,
 * locking the rows and logging the audit trail inside one transaction.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import type { IngredientId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  ingredient,
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
import { impact, present } from "~/server/repo/impact";
import { removeEntity } from "~/server/repo/removal";

export const INGREDIENT_DELETE_EDGE_POLICY = {
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
} as const satisfies IncomingEdgePolicy<"ingredient", OperationDisposition>;

/**
 * Live recipe-line usages of the given ingredients — joined through section
 * and recipe so a usage whose parent recipe/section is soft-deleted doesn't
 * count. Must filter all three join levels (usage → section → recipe) so an
 * ingredient whose only usages live in soft-deleted recipes doesn't block
 * deletion — this matches `liveRecipeCountForIngredientSql`'s liveness
 * semantics, so the guard and the displayed recipe count never disagree.
 *
 * Shared by `deleteIngredients` (which refuses when any exist) and
 * `previewDeleteIngredients` (which counts them), so the two can't disagree
 * about what counts as a live usage.
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
 * Live products linked to the given ingredients. Shared by `deleteIngredients`
 * and `previewDeleteIngredients` for the same reason as
 * {@link findLiveRecipeUsagesOfIngredients}.
 */
const findLiveProductsLinkedToIngredients = (
  db: Database | DrizzleTransaction,
  ids: IngredientId[],
) =>
  unwrapDb(db).query.product.findMany({
    where: and(inArray(product.ingredientId, ids), notDeleted(product)),
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

    // No `children`: an ingredient delete has no cascaded child rows.
    await removeEntity(tx, {
      entity: "ingredient",
      ids,
      removal: "soft",
      actor,
    });
  });
};

/**
 * What `deleteIngredients` would do to the given ingredients, without doing
 * it.
 *
 * Reads the SAME `INGREDIENT_DELETE_EDGE_POLICY` and the same two predicates
 * ({@link findLiveRecipeUsagesOfIngredients},
 * {@link findLiveProductsLinkedToIngredients}) the mutation's guard uses, so
 * the preview cannot claim a delete will succeed that the guard then refuses.
 * Both edges are blockers — an ingredient delete has no cascade edges (hence
 * the childless `removeEntity` above), so `changes` is always empty.
 *
 * Advisory only. `deleteIngredients` still re-runs every check inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewDeleteIngredients = async (
  db: Database,
  ids: IngredientId[],
): Promise<{ blockers: ImpactItem[]; changes: ImpactItem[] }> => {
  if (ids.length === 0) return { blockers: [], changes: [] };

  const byTargetId = (rows: Array<{ ingredientId: IngredientId | null }>) => {
    const out: Record<string, number> = {};
    for (const { ingredientId } of rows) {
      if (ingredientId) out[ingredientId] = (out[ingredientId] ?? 0) + 1;
    }
    return out;
  };

  const [usedInRecipes, linkedProducts] = await Promise.all([
    findLiveRecipeUsagesOfIngredients(db, ids),
    findLiveProductsLinkedToIngredients(db, ids),
  ]);

  const blockers = present([
    impact({
      disposition:
        INGREDIENT_DELETE_EDGE_POLICY["RecipeSectionIngredient.ingredientId"],
      edgeKey: "RecipeSectionIngredient.ingredientId",
      label: "recipe usages",
      byTargetId: byTargetId(usedInRecipes),
    }),
    impact({
      disposition: INGREDIENT_DELETE_EDGE_POLICY["Product.ingredientId"],
      edgeKey: "Product.ingredientId",
      label: "linked products",
      byTargetId: byTargetId(linkedProducts),
    }),
  ]);

  return { blockers, changes: [] };
};
