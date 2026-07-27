/**
 * Meal Router — meal planning (calendar + shopping list).
 *
 * Standard CRUD over the `meal` entity plus child mutations for the planned
 * recipes, a date-range query for the calendar, and a display-only shopping list
 * that aggregates scaled needs across meals vs. on-hand inventory (Phase 0
 * engine, AvailabilityService.getAggregatedNeeds). No inventory is ever mutated.
 */

import type { RecipeId } from "@cubby/schemas/identifiers";
import { type MealId, mealId } from "@cubby/schemas/identifiers";
import {
  mealAddRecipeInput,
  mealCreateInput,
  mealDateRange,
  mealFiltersSchema,
  mealListOut,
  mealOut,
  mealRecipeIdInput,
  mealSortableFields,
  mealUpdateData,
  mealUpdateRecipeInput,
  type ShoppingListContribution,
  shoppingListOut,
} from "@cubby/schemas/meal";
import { createAppError } from "~/server/errors/app-error";
import {
  addRecipeToMeal,
  createMeal,
  deleteMeals,
  getMealByID,
  getMealsByDateRange,
  mealList,
  removeMealRecipe,
  updateMeal,
  updateMealRecipe,
} from "~/server/repo/meal";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const {
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
} = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: mealCreateInput,
    updateInput: mealUpdateData,
    output: mealOut,
    filters: mealFiltersSchema,
    sort: { sortableFields: mealSortableFields, defaultSort: "date" },
    idSchema: mealId,
  },
  repository: {
    getByID: async (services, id: MealId) => {
      const res = await getMealByID(services.db, id);
      if (!res) {
        throw createAppError("MEAL_NOT_FOUND", "Meal not found");
      }
      return res;
    },
    list: async (services, filters, sort, pagination) =>
      mealList(services.db, filters, sort, pagination),
    create: async (services, data) =>
      createMeal(services.db, data, services.actorContext),
    update: async (services, id: MealId, data) =>
      updateMeal(services.db, id, data, services.actorContext),
    delete: async (services, ids) => {
      await deleteMeals(services.db, ids, services.actorContext);
      return undefined;
    },
  },
  entityName: "meal",
});

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
  .output(mealListOut)
  .query(({ ctx, input }) => getMealsByDateRange(ctx.db, input.from, input.to));

const addRecipe = protectedProcedure
  .input(mealAddRecipeInput)
  .output(mealOut)
  .mutation(async ({ ctx, input }) => {
    const updated = await addRecipeToMeal(
      ctx.db,
      input.mealId,
      {
        recipeId: input.recipeId,
        scale: input.scale,
        sortOrder: input.sortOrder,
      },
      ctx.actorContext,
    );
    await refreshMealEmbedding(ctx.db, updated.id, "meal.addRecipe");
    return updated;
  });

const updateRecipe = protectedProcedure
  .input(mealUpdateRecipeInput)
  .output(mealOut)
  // Scale/order only — the meal's embedding text doesn't include either, so no
  // embedding refresh here (unlike add/remove, which change the recipe set).
  .mutation(({ ctx, input }) =>
    updateMealRecipe(
      ctx.db,
      input.id,
      { scale: input.scale, sortOrder: input.sortOrder },
      ctx.actorContext,
    ),
  );

const removeRecipe = protectedProcedure
  .input(mealRecipeIdInput)
  .output(mealOut)
  .mutation(async ({ ctx, input }) => {
    const updated = await removeMealRecipe(ctx.db, input.id, ctx.actorContext);
    await refreshMealEmbedding(ctx.db, updated.id, "meal.removeRecipe");
    return updated;
  });

const getShoppingList = protectedProcedure
  .input(mealDateRange)
  .output(shoppingListOut)
  .query(async ({ ctx, input }) => {
    const meals = await getMealsByDateRange(ctx.db, input.from, input.to);

    // Flatten meals → planned recipes into `lines` for the aggregation engine,
    // keeping a parallel `lineMeta` so each contribution maps back to its meal.
    const lines: { recipeId: RecipeId; scale: number }[] = [];
    const lineMeta: Omit<ShoppingListContribution, "needValue">[] = [];
    for (const m of meals) {
      for (const mr of m.recipes) {
        lines.push({ recipeId: mr.recipeId, scale: mr.scale });
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

    const needs = await ctx.services.availability.getAggregatedNeeds(lines);

    const items = needs
      .map((n) => {
        const have = n.haveValue ?? 0;
        return {
          ingredientId: n.ingredientId,
          name: n.name,
          basisUnit: n.basisUnit,
          needValue: n.needValue,
          haveValue: n.haveValue,
          shortfall: Math.max(0, n.needValue - have),
          status: n.status,
          perMeal: n.sources.flatMap((s) => {
            const meta = lineMeta[s.lineIndex];
            return meta ? [{ ...meta, needValue: s.needValue }] : [];
          }),
        };
      })
      // Surface what you need to buy first, then alphabetical.
      .sort(
        (a, b) => b.shortfall - a.shortfall || a.name.localeCompare(b.name),
      );

    return {
      from: input.from,
      to: input.to,
      meals: meals.map((m) => ({ id: m.id, name: m.name, date: m.date })),
      items,
    };
  });

export const mealRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
  getByDateRange,
  getShoppingList,
  addRecipe,
  updateRecipe,
  removeRecipe,
});
