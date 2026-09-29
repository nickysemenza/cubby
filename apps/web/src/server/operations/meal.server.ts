import type {
  AggregatedNeed,
  BlockedSubRecipe,
} from "@cubby/schemas/availability";
import type { MealId } from "@cubby/schemas/identifiers";
import type {
  SaveMealRecipePreparationInput,
  mealAddRecipeInput,
  shoppingListInput,
  mealRecipeIdInput,
  mealUpdateRecipeInput,
  ShoppingListContribution,
} from "@cubby/schemas/meal";
import { contributesToShoppingList } from "@cubby/schemas/meal-classification";
import { sumBy } from "es-toolkit";

import { mealContract } from "~/contracts/meal.contract";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  addRecipeToMeal,
  getMealPreparations,
  getMealsByDateRange,
  getUpcomingMealSummary,
  removeMealRecipeWithEntityId,
  saveMealRecipePreparation,
  updateMealRecipeWithEntityId,
} from "~/server/repo/meal";
import { saveMealFood, removeMealFood } from "~/server/repo/meal/food";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import type {
  AvailabilityService,
  PlannedLine,
} from "~/server/services/availability.service";
import { getMealNutrition } from "~/server/services/meal-nutrition.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

const mealShortcodes = bindShortcodeResolver("meal");

const refreshMealEmbedding = (db: Database, id: MealId, source: string) =>
  runMutationSideEffects(db, {
    action: "updated",
    entity: { entity: "meal", id: id },
    source,
  });

type MealMutationContext = {
  db: Database;
  actorContext: Parameters<typeof saveMealRecipePreparation>[2];
};

export const saveMealRecipePreparationWorkflow = bindWorkflow(
  workflow<MealMutationContext, SaveMealRecipePreparationInput>(
    "meal.savePreparation",
  )
    .commit("saved", async ({ context }, { input }) =>
      saveMealRecipePreparation(context.db, input, context.actorContext),
    )
    .effect("embeddings", async ({ context }, { saved }) => {
      const affectedIds = await mealShortcodes.all(
        context.db,
        saved.affectedMealIds,
      );
      return Promise.all(
        affectedIds.map((id) =>
          refreshMealEmbedding(context.db, id, "meal.savePreparation"),
        ),
      );
    })
    .output(({ saved }) => saved),
);

export const addRecipeToMealWorkflow = bindWorkflow(
  workflow<MealMutationContext, typeof mealAddRecipeInput._output>(
    "meal.addRecipe",
  )
    .call("mealId", async ({ context }, { input }) =>
      mealShortcodes.one(context.db, input.mealId),
    )
    .commit("updated", async ({ context }, { input, mealId }) =>
      addRecipeToMeal(
        context.db,
        mealId,
        {
          recipeId: input.recipeId,
          scale: input.scale,
          sortOrder: input.sortOrder,
        },
        context.actorContext,
      ),
    )
    .effect("embedding", async ({ context }, { mealId }) =>
      refreshMealEmbedding(context.db, mealId, "meal.addRecipe"),
    )
    .output(({ updated }) => updated),
);

export async function updateMealRecipeWorkflow(
  context: MealMutationContext,
  input: typeof mealUpdateRecipeInput._output,
) {
  const updated = await updateMealRecipeWithEntityId(
    context.db,
    input.id,
    { scale: input.scale, sortOrder: input.sortOrder },
    context.actorContext,
  );
  return updated.output;
}

export const removeMealRecipeWorkflow = bindWorkflow(
  workflow<MealMutationContext, typeof mealRecipeIdInput._output>(
    "meal.removeRecipe",
  )
    .commit("removed", async ({ context }, { input }) =>
      removeMealRecipeWithEntityId(context.db, input.id, context.actorContext),
    )
    .effect("embedding", async ({ context }, { removed }) =>
      refreshMealEmbedding(context.db, removed.entityId, "meal.removeRecipe"),
    )
    .output(({ removed }) => removed.output),
);

type ShoppingInput = typeof shoppingListInput._output;
type ShoppingMeals = Awaited<ReturnType<typeof getMealsByDateRange>>;

const selectShoppingRequirements = (
  input: ShoppingInput,
  meals: ShoppingMeals,
) => {
  const publicLines: PlannedLine[] = [];
  const lineMeta: Omit<
    ShoppingListContribution,
    "needValue" | "lineIndex" | "via" | "amount"
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
  const excluded = new Set(input.excludedMealIds ?? []);
  for (const m of cookedMeals.filter((meal) => !excluded.has(meal.id)))
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
  return { input, cookedMeals, omittedMeals, publicLines, lineMeta };
};

const presentShoppingRequirements = ({
  input,
  cookedMeals,
  omittedMeals,
  lineMeta,
  needs,
  unexpanded,
}: ReturnType<typeof selectShoppingRequirements> &
  Awaited<ReturnType<AvailabilityService["getAggregatedNeeds"]>>) => {
  const items = needs
    .map((n: AggregatedNeed) => ({
      ingredientId: n.ingredientId,
      name: n.name,
      basisUnit: n.basisUnit,
      needValue: n.needValue,
      haveValue: n.haveValue,
      shortfall: n.shortfall,
      status: n.status,
      usuallyOnHand: n.usuallyOnHand,
      covered: n.covered,
      availabilitySource: n.availabilitySource,
      quantityIssues: n.quantityIssues,
      membership: n.usuallyOnHand
        ? ("usuallyOnHand" as const)
        : n.covered && n.quantityIssues.length === 0
          ? ("covered" as const)
          : ("buy" as const),
      estimatedCost: n.usuallyOnHand ? null : n.estimatedCost,
      perMeal: n.sources.flatMap((s) => {
        const meta = lineMeta[s.lineIndex];
        return meta
          ? [
              {
                ...meta,
                needValue: s.needValue,
                amount: s.amount,
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
    estimatedTotal: sumBy(items, (i) =>
      i.membership === "buy" ? (i.estimatedCost ?? 0) : 0,
    ),
    pricedItems: items.filter(
      (i) => i.membership === "buy" && i.estimatedCost != null,
    ).length,
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

export async function getShoppingListWorkflow(
  db: Database,
  input: ShoppingInput,
  availability: Pick<AvailabilityService, "getAggregatedNeeds">,
) {
  const meals = await getMealsByDateRange(db, input.from, input.to);
  const selection = selectShoppingRequirements(input, meals);
  return presentShoppingRequirements({
    ...selection,
    ...(await availability.getAggregatedNeeds(selection.publicLines)),
  });
}

export const mealHandlers = implementOperationDomain(mealContract, {
  getNutrition: (context, input) =>
    getMealNutrition(
      context.db,
      input,
      context.usdaClient,
      context.services.recipeCosting,
    ),
  saveFood: (context, input) =>
    saveMealFood(context.db, input, context.actorContext),
  removeFood: (context, input) =>
    removeMealFood(context.db, input, context.actorContext),
  getByDateRange: (context, input) =>
    getMealsByDateRange(context.db, input.from, input.to),
  upcomingSummary: (context, input) =>
    getUpcomingMealSummary(context.db, input.from, input.to),
  getPreparations: (context, input) =>
    getMealPreparations(context.db, input, context.services.recipeCosting),
  getShoppingList: (context, input) =>
    getShoppingListWorkflow(context.db, input, context.services.availability),
  addRecipe: async (context, input) =>
    (await addRecipeToMealWorkflow(context, input)).meal,
  updateRecipe: (context, input) => updateMealRecipeWorkflow(context, input),
  removeRecipe: (context, input) => removeMealRecipeWorkflow(context, input),
  savePreparation: (context, input) =>
    saveMealRecipePreparationWorkflow(context, input),
});
