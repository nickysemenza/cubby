import type {
  AggregatedNeed,
  BlockedSubRecipe,
} from "@cubby/schemas/availability";
import type { MealId } from "@cubby/schemas/identifiers";
import type {
  GetMealPreparationsInput,
  SaveMealRecipePreparationInput,
  mealAddRecipeInput,
  mealDateRange,
  mealRecipeIdInput,
  mealUpdateRecipeInput,
  ShoppingListContribution,
} from "@cubby/schemas/meal";
import { contributesToShoppingList } from "@cubby/schemas/meal-classification";
import { sumBy } from "es-toolkit";

import type { Database } from "~/server/db";
import {
  addRecipeToMeal,
  getMealPreparations,
  getMealsByDateRange,
  getUpcomingMealSummary,
  removeMealRecipeWithEntityId,
  saveMealRecipePreparation,
  updateMealRecipeWithEntityId,
} from "~/server/repo/meal";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import type {
  AvailabilityService,
  PlannedLine,
} from "~/server/services/availability.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";

const mealShortcodes = bindShortcodeResolver("meal");

const refreshMealEmbedding = (db: Database, id: MealId, source: string) =>
  runMutationSideEffects(db, {
    action: "updated",
    entity: { entityType: "meal", entityId: id },
    source,
  });

export const getMealsByDateRangeWorkflow = (
  db: Database,
  input: { from: string; to: string },
) => getMealsByDateRange(db, input.from, input.to);
export const getUpcomingMealSummaryWorkflow = (
  db: Database,
  input: { from: string; to: string },
) => getUpcomingMealSummary(db, input.from, input.to);
export const getMealPreparationsWorkflow = (
  db: Database,
  input: GetMealPreparationsInput,
) => getMealPreparations(db, input);
export const saveMealRecipePreparationWorkflow = async (
  db: Database,
  input: SaveMealRecipePreparationInput,
  actorContext: Parameters<typeof saveMealRecipePreparation>[2],
) => {
  const saved = await saveMealRecipePreparation(db, input, actorContext);
  const affectedIds = await mealShortcodes.all(db, saved.affectedMealIds);
  await Promise.all(
    affectedIds.map((id) =>
      refreshMealEmbedding(db, id, "meal.savePreparation"),
    ),
  );
  return saved;
};
export const addRecipeToMealWorkflow = async (
  db: Database,
  input: typeof mealAddRecipeInput._output,
  actorContext: Parameters<typeof addRecipeToMeal>[3],
) => {
  const mealId = await mealShortcodes.one(db, input.mealId);
  const updated = await addRecipeToMeal(
    db,
    mealId,
    {
      recipeId: input.recipeId,
      scale: input.scale,
      sortOrder: input.sortOrder,
    },
    actorContext,
  );
  await refreshMealEmbedding(db, mealId, "meal.addRecipe");
  return updated;
};
export const updateMealRecipeWorkflow = async (
  db: Database,
  input: typeof mealUpdateRecipeInput._output,
  actorContext: Parameters<typeof updateMealRecipeWithEntityId>[3],
) =>
  (
    await updateMealRecipeWithEntityId(
      db,
      input.id,
      { scale: input.scale, sortOrder: input.sortOrder },
      actorContext,
    )
  ).output;
export const removeMealRecipeWorkflow = async (
  db: Database,
  input: typeof mealRecipeIdInput._output,
  actorContext: Parameters<typeof removeMealRecipeWithEntityId>[2],
) => {
  const { output, entityId } = await removeMealRecipeWithEntityId(
    db,
    input.id,
    actorContext,
  );
  await refreshMealEmbedding(db, entityId, "meal.removeRecipe");
  return output;
};

export const getShoppingListWorkflow = async (
  db: Database,
  input: typeof mealDateRange._output,
  availability: Pick<AvailabilityService, "getAggregatedNeeds">,
) => {
  const meals = await getMealsByDateRange(db, input.from, input.to);
  const publicLines: PlannedLine[] = [];
  const lineMeta: Omit<
    ShoppingListContribution,
    "needValue" | "lineIndex" | "via"
  >[] = [];
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
  for (const m of cookedMeals)
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
  const { needs, unexpanded } =
    await availability.getAggregatedNeeds(publicLines);
  const items = needs
    .map((n: AggregatedNeed) => ({
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
                lineIndex: s.lineIndex,
                via: s.via,
              },
            ]
          : [];
      }),
    }))
    .sort(
      (a, b) =>
        (b.shortfall ?? 0) - (a.shortfall ?? 0) || a.name.localeCompare(b.name),
    );
  return {
    from: input.from,
    to: input.to,
    meals: cookedMeals.map((m) => ({ id: m.id, name: m.name, date: m.date })),
    omittedMeals,
    items,
    estimatedTotal: sumBy(items, (i) => i.estimatedCost ?? 0),
    pricedItems: items.filter((i) => i.estimatedCost != null).length,
    unexpanded: unexpanded.flatMap((b: BlockedSubRecipe) => {
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
};
