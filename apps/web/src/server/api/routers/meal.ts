/**
 * Meal Router — meal planning (calendar + shopping list).
 *
 * Standard CRUD over the `meal` entity plus child mutations for the planned
 * recipes, a date-range query for the calendar, and a display-only shopping list
 * that aggregates scaled needs across meals vs. on-hand inventory (Phase 0
 * engine, AvailabilityService.getAggregatedNeeds). No inventory is ever mutated.
 */

import type { MealId } from "@cubby/schemas/identifiers";
import {
  mealAddRecipeInput,
  mealDateRange,
  mealListOut,
  mealOut,
  mealRecipeIdInput,
  mealUpdateRecipeInput,
  type ShoppingListContribution,
  shoppingListOut,
  upcomingMealSummaryOut,
} from "@cubby/schemas/meal";
import { contributesToShoppingList } from "@cubby/schemas/meal-classification";
import { sumBy } from "es-toolkit";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { ENTITY_KERNEL_BINDINGS } from "~/server/entity-kernel/registry";
import {
  addRecipeToMeal,
  getMealsByDateRange,
  getUpcomingMealSummary,
  removeMealRecipeWithEntityId,
  updateMealRecipeWithEntityId,
} from "~/server/repo/meal";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import type { PlannedLine } from "~/server/services/availability.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { createEntityCompatibilityProcedures } from "../entity-compatibility";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const {
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
} = createEntityCompatibilityProcedures(
  ENTITY_KERNEL_BINDINGS.meal,
  ENTITY_BINDINGS.meal.crud,
);

const mealShortcodes = bindShortcodeResolver("meal");

// A meal's embedding text is mostly its planned recipes' names, so the child
// mutations count as an update to the meal itself.
const refreshMealEmbedding = (
  db: Parameters<typeof runMutationSideEffects>[0],
  id: MealId,
  source: string,
) =>
  runMutationSideEffects(db, {
    action: "updated",
    entity: { entityType: "meal", entityId: id },
    source,
  });

const getByDateRange = protectedProcedure
  .input(mealDateRange)
  .output(strictOutput(mealListOut))
  .query(({ ctx, input }) => getMealsByDateRange(ctx.db, input.from, input.to));

const upcomingSummary = protectedProcedure
  .input(mealDateRange)
  .output(strictOutput(upcomingMealSummaryOut))
  .query(({ ctx, input }) =>
    getUpcomingMealSummary(ctx.db, input.from, input.to),
  );

const addRecipe = protectedProcedure
  .input(mealAddRecipeInput)
  .output(strictOutput(mealOut))
  .mutation(async ({ ctx, input }) => {
    const mealId = await mealShortcodes.one(ctx.db, input.mealId);
    const updated = await addRecipeToMeal(
      ctx.db,
      mealId,
      {
        recipeId: input.recipeId,
        scale: input.scale,
        sortOrder: input.sortOrder,
      },
      ctx.actorContext,
    );
    await refreshMealEmbedding(ctx.db, mealId, "meal.addRecipe");
    return updated;
  });

const updateRecipe = protectedProcedure
  .input(mealUpdateRecipeInput)
  .output(strictOutput(mealOut))
  // Scale/order only — the meal's embedding text doesn't include either, so no
  // embedding refresh here (unlike add/remove, which change the recipe set).
  .mutation(async ({ ctx, input }) => {
    const { output } = await updateMealRecipeWithEntityId(
      ctx.db,
      input.id,
      { scale: input.scale, sortOrder: input.sortOrder },
      ctx.actorContext,
    );
    return output;
  });

const removeRecipe = protectedProcedure
  .input(mealRecipeIdInput)
  .output(strictOutput(mealOut))
  .mutation(async ({ ctx, input }) => {
    const { output, entityId } = await removeMealRecipeWithEntityId(
      ctx.db,
      input.id,
      ctx.actorContext,
    );
    await refreshMealEmbedding(ctx.db, entityId, "meal.removeRecipe");
    return output;
  });

const getShoppingList = protectedProcedure
  .input(mealDateRange)
  .output(strictOutput(shoppingListOut))
  .query(async ({ ctx, input }) => {
    const meals = await getMealsByDateRange(ctx.db, input.from, input.to);

    // Flatten meals → planned recipes into `lines` for the aggregation engine,
    // keeping a parallel `lineMeta` so each contribution maps back to its meal.
    const publicLines: PlannedLine[] = [];
    const lineMeta: Omit<
      ShoppingListContribution,
      "needValue" | "lineIndex" | "via"
    >[] = [];
    // A meal you aren't cooking contributes nothing to buy: an eating-out
    // night has no recipes to aggregate, and a leftovers night's ingredients
    // were already bought when the meal was first cooked — counting them again
    // would double the shopping list. Partitioned rather than filtered so the
    // omission can be disclosed instead of silently vanishing.
    const cookedMeals = meals.filter((m) =>
      contributesToShoppingList(m.mealKind),
    );
    const omittedMeals = meals
      .filter((m) => !contributesToShoppingList(m.mealKind))
      .map((m) => ({
        id: m.id,
        name: m.name,
        date: m.date,
        mealKind: m.mealKind,
      }));

    for (const m of cookedMeals) {
      for (const mr of m.recipes) {
        publicLines.push({ recipeId: mr.recipeId, scale: mr.scale });
        lineMeta.push({
          mealId: m.id,
          mealName: m.name,
          date: m.date,
          recipeId: mr.recipeId,
          recipeName: mr.recipe.name,
          scale: mr.scale,
        });
      }
    }

    const { needs, unexpanded } =
      await ctx.services.availability.getAggregatedNeeds(publicLines);

    const items = needs
      .map((n) => {
        return {
          ingredientId: n.ingredientId,
          name: n.name,
          basisUnit: n.basisUnit,
          needValue: n.needValue,
          haveValue: n.haveValue,
          shortfall: n.shortfall,
          status: n.status,
          estimatedCost: n.estimatedCost,
          perMeal: n.sources.flatMap((s) => {
            const meta = lineMeta[s.lineIndex];
            return meta
              ? [
                  {
                    ...meta,
                    needValue: s.needValue,
                    // The line index is what distinguishes two columns when one
                    // meal plans the same recipe twice; `meta` alone can't.
                    lineIndex: s.lineIndex,
                    via: s.via,
                  },
                ]
              : [];
          }),
        };
      })
      // Surface what you need to buy first, then alphabetical.
      .sort(
        // Unknown shortfall sorts with the zeros, not above the real ones —
        // it's not evidence you need to buy anything.
        (a, b) =>
          (b.shortfall ?? 0) - (a.shortfall ?? 0) ||
          a.name.localeCompare(b.name),
      );

    return {
      from: input.from,
      to: input.to,
      meals: cookedMeals.map((m) => ({ id: m.id, name: m.name, date: m.date })),
      omittedMeals,
      items,
      // Sum of what CAN be priced, plus how many rows that was. A total over
      // half the list must be readable as such, so the count travels with it
      // rather than the UI guessing from nulls.
      estimatedTotal: sumBy(items, (i) => i.estimatedCost ?? 0),
      pricedItems: items.filter((i) => i.estimatedCost != null).length,
      // Attribute each un-expandable sub-recipe back to the meal that asked
      // for it, so the disclosure can name where the gap is.
      unexpanded: unexpanded.flatMap((b) => {
        const meta = lineMeta[b.lineIndex];
        return meta
          ? [
              {
                recipeId: b.recipeId,
                name: b.name,
                reason: b.reason,
                amount: b.amount,
                via: b.via,
                mealId: meta.mealId,
                mealName: meta.mealName,
                date: meta.date,
                parentRecipeId: meta.recipeId,
                parentRecipeName: meta.recipeName,
                lineIndex: b.lineIndex,
              },
            ]
          : [];
      }),
    };
  });

export const mealRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
  getByDateRange,
  upcomingSummary,
  getShoppingList,
  addRecipe,
  updateRecipe,
  removeRecipe,
});
