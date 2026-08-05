/**
 * Meal Router — meal planning (calendar + shopping list).
 *
 * Standard CRUD over the `meal` entity plus child mutations for the planned
 * recipes, a date-range query for the calendar, and a display-only shopping list
 * that aggregates scaled needs across meals vs. on-hand inventory (Phase 0
 * engine, AvailabilityService.getAggregatedNeeds). No inventory is ever mutated.
 */

import {
  type MealId,
  type MealShortcode,
  mealShortcode,
} from "@cubby/schemas/identifiers";
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
  createMealWithEntityId,
  deleteMeals,
  getMealByID,
  getMealByShortcode,
  getMealsByDateRange,
  mealList,
  removeMealRecipeWithEntityId,
  updateMeal,
  updateMealRecipeWithEntityId,
} from "~/server/repo/meal";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import type { PlannedLine } from "~/server/services/availability.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const {
  getByID,
  getByShortcode,
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
    idSchema: mealShortcode,
  },
  repository: {
    getByID: async (services, shortcode: MealShortcode) => {
      const id = await resolveMealEntityId(services.db, shortcode);
      const res = await getMealByID(services.db, id);
      if (!res) {
        throw createAppError("MEAL_NOT_FOUND", "Meal not found");
      }
      return res;
    },
    getByShortcode: (services, shortcode) =>
      getMealByShortcode(services.db, shortcode),
    list: async (services, filters, sort, pagination) =>
      mealList(services.db, filters, sort, pagination),
    create: (services, data) =>
      createMealWithEntityId(services.db, data, services.actorContext),
    update: async (services, shortcode: MealShortcode, data) => {
      const id = await resolveMealEntityId(services.db, shortcode);
      const output = await updateMeal(
        services.db,
        id,
        data,
        services.actorContext,
      );
      return { output, entityId: id };
    },
    delete: async (services, shortcodes: MealShortcode[]) => {
      const ids = await resolveMealEntityIds(services.db, shortcodes);
      await deleteMeals(services.db, ids, services.actorContext);
      return undefined;
    },
  },
  entityName: "meal",
});

const resolveMealEntityId = async (
  db: Parameters<typeof resolveOrThrow>[0],
  shortcode: MealShortcode,
): Promise<MealId> => {
  return resolveOrThrow(db, "meal", shortcode);
};

const resolveMealEntityIds = async (
  db: Parameters<typeof resolveAllOrThrow>[0],
  shortcodes: MealShortcode[],
): Promise<MealId[]> => {
  return resolveAllOrThrow(db, "meal", shortcodes);
};

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

const addRecipe = protectedProcedure
  .input(mealAddRecipeInput)
  .output(strictOutput(mealOut))
  .mutation(async ({ ctx, input }) => {
    const mealId = await resolveMealEntityId(ctx.db, input.mealId);
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
    for (const m of meals) {
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
        (a, b) => b.shortfall - a.shortfall || a.name.localeCompare(b.name),
      );

    return {
      from: input.from,
      to: input.to,
      meals: meals.map((m) => ({ id: m.id, name: m.name, date: m.date })),
      items,
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
  getByShortcode,
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
