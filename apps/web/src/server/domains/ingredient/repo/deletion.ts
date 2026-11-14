import type { ActorContext } from "@cubby/schemas/context";
/**
 * Ingredient soft-delete with dependency guards.
 * The declared policy refuses live products and meal food entries and clears
 * plant links; only recipe usage needs its own three-level liveness guard.
 */
import type { IngredientId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database, DrizzleTransaction } from "~/server/db";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { DECLARED_EDGE_DELETE_HOOKS } from "~/server/db/generated/declared-edges.gen";
import { assertNoDependents, notDeleted, unwrapDb } from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import {
  ingredient,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";

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

export const refuseLiveRecipeUsage = async (
  tx: DrizzleTransaction,
  ids: IngredientId[],
) => {
  const used = await findLiveRecipeUsagesOfIngredients(tx, ids);
  await assertNoDependents({
    offendingParentIds: used.map((row) => row.ingredientId),
    fetchNames: (failedIds: IngredientId[]) =>
      tx.query.ingredient.findMany({
        where: {
          RAW: (table: PgTable) =>
            relationalSql(table, inArray(ingredient.id, failedIds)),
        },
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
    policy: DECLARED_EDGE_DELETE_POLICIES.ingredient,
    ids,
    actor,
    ...DECLARED_EDGE_DELETE_HOOKS.ingredient,
  });
