import type {
  AggregatedNeed,
  BlockedSubRecipe,
} from "@cubby/schemas/availability";
import type { MealId } from "@cubby/schemas/identifiers";
import type {
  MealPreparationNutritionDetail,
  SaveMealRecipePreparationInput,
  mealAddRecipeInput,
  shoppingListInput,
  mealRecipeIdInput,
  mealUpdateRecipeInput,
  ShoppingListContribution,
} from "@cubby/schemas/meal";
import { contributesToShoppingList } from "@cubby/schemas/meal-classification";
import {
  type MeasureEstimate,
  nutrientKey,
  type NutritionTotals,
  type NutritionTotalsPartial,
} from "@cubby/schemas/nutrition";
import { sumBy } from "es-toolkit";
import type { z } from "zod";

import { slimMeal } from "~/contracts/mcp-projections";
import {
  type addRecipeNutritionDetail,
  type compactEstimate,
  type dailyIntakeInput,
  type mealCopyRangeInput,
  type mealDuplicateInput,
  mealContract,
} from "~/contracts/meal.contract";
import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import {
  addRecipeToMeal,
  getMealPreparations,
  getMealsByDateRange,
  getUpcomingMealSummary,
  removeMealRecipeWithEntityId,
  saveMealRecipePreparation,
  updateMeal,
  updateMealRecipeWithEntityId,
} from "~/server/repo/meal";
import { getMealByID } from "~/server/repo/meal";
import { copyMealRange, duplicateMeal } from "~/server/repo/meal/copy";
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
      withTransactionDatabase(context.db, async (db) => {
        if (input.convertToCooked)
          await updateMeal(
            db,
            mealId,
            { mealKind: "cooked" },
            context.actorContext,
          );
        return addRecipeToMeal(
          db,
          mealId,
          {
            recipeId: input.recipeId,
            scale: input.scale,
            sortOrder: input.sortOrder,
          },
          context.actorContext,
        );
      }),
    )
    .effect("embedding", async ({ context }, { mealId }) =>
      refreshMealEmbedding(context.db, mealId, "meal.addRecipe"),
    )
    .output(({ updated }) => updated),
);

export const duplicateMealWorkflow = bindWorkflow(
  workflow<MealMutationContext, typeof mealDuplicateInput._output>(
    "meal.duplicate",
  )
    .call("mealId", async ({ context }, { input }) =>
      mealShortcodes.one(context.db, input.mealId),
    )
    .commit("copied", async ({ context }, { input, mealId }) =>
      duplicateMeal(context.db, context.actorContext, mealId, input.date),
    )
    .effect("embeddings", async ({ context }, { copied }) =>
      Promise.all(
        copied.mealIds.map((id) =>
          refreshMealEmbedding(context.db, id, "meal.duplicate"),
        ),
      ),
    )
    .output(({ copied }) => copied),
);

export const copyMealRangeWorkflow = bindWorkflow(
  workflow<MealMutationContext, typeof mealCopyRangeInput._output>(
    "meal.copyRange",
  )
    .commit("copied", async ({ context }, { input }) =>
      copyMealRange(context.db, context.actorContext, input),
    )
    .effect("embeddings", async ({ context }, { copied }) =>
      Promise.all(
        copied.mealIds.map((id) =>
          refreshMealEmbedding(context.db, id, "meal.copyRange"),
        ),
      ),
    )
    .output(({ copied }) => copied),
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
  duplicate: async (context, input) => {
    const copied = await duplicateMealWorkflow(context, input);
    const created = await getMealByID(context.db, copied.mealIds[0]!);
    if (!created) throw new Error("Duplicated meal could not be reloaded");
    return created;
  },
  copyRange: async (context, input) => {
    const copied = await copyMealRangeWorkflow(context, input);
    return {
      copied: copied.mealIds.length,
      mealIds: copied.mealShortcodes,
      skippedPortions: copied.skippedPortions,
    };
  },
  updateRecipe: (context, input) => updateMealRecipeWorkflow(context, input),
  removeRecipe: (context, input) => removeMealRecipeWorkflow(context, input),
  savePreparation: (context, input) =>
    saveMealRecipePreparationWorkflow(context, input),
  dailyIntake: async (context, input) =>
    dailyIntake(
      await getMealNutrition(
        context.db,
        { date: input.date },
        context.usdaClient,
        context.services.recipeCosting,
      ),
      input,
    ),
  preparationsDetail: async (context, input) =>
    mealPreparations(
      await getMealPreparations(
        context.db,
        { mealId: input.mealId },
        context.services.recipeCosting,
      ),
      input.nutrition,
    ),
  planRecipe: async (context, input) =>
    addedMealRecipe(
      await addRecipeToMealWorkflow(context, {
        mealId: input.mealId,
        recipeId: input.recipeId,
        scale: input.scale,
        sortOrder: input.sortOrder,
      }),
      input.nutrition,
    ),
});

const macroKeys = ["kcal", "protein", "carbs", "fat", "fiber"] as const;

function compactValue(value: MeasureEstimate): z.infer<typeof compactEstimate> {
  if (value.status === "unavailable") return null;
  if (value.status === "pending") return "pending";
  if (
    value.status === "complete" &&
    (value.upper === null || value.upper === value.lower)
  )
    return value.lower;
  return {
    lower: value.lower,
    upper: value.upper,
    partial: value.status === "partial",
  };
}

function compactTotals(totals: NutritionTotals, detail: "macros" | "full") {
  const keys = detail === "macros" ? macroKeys : nutrientKey.options;
  return Object.fromEntries(
    keys.map((key) => [key, compactValue(totals.nutrition[key])]),
  );
}

/** Keep cost and the requested nutrient estimates for the preparation read. */
const trimNutrition =
  (detail: MealPreparationNutritionDetail) =>
  (totals: NutritionTotals): NutritionTotalsPartial => {
    if (detail === "full") return totals;
    if (detail === "macros")
      return {
        cost: totals.cost,
        nutrition: Object.fromEntries(
          macroKeys.map((key) => [key, totals.nutrition[key]]),
        ),
      };
    if (detail === "kcal")
      return { cost: totals.cost, nutrition: { kcal: totals.nutrition.kcal } };
    return { cost: totals.cost, nutrition: {} };
  };

/** The meal-nutrition read projected onto one eater. */
export function dailyIntake(
  summary: Awaited<ReturnType<typeof getMealNutrition>>,
  params: z.output<typeof dailyIntakeInput>,
) {
  const person = summary.people.find(
    (candidate) => candidate.eater.id === params.partyId,
  );
  return {
    date: params.date,
    partyId: params.partyId,
    status:
      params.date > householdLocalDate()
        ? ("planned" as const)
        : ("logged" as const),
    nutrition: person ? compactTotals(person.totals, params.nutrition) : null,
    meals:
      person?.meals.map(({ meal, totals }) => ({
        mealId: meal.id,
        name: meal.name,
        nutrition: compactTotals(totals, params.nutrition),
        foods: params.includeFoods
          ? person.foods
              .filter((food) => food.meal.id === meal.id)
              .map((food) => ({
                name: food.name,
                grams: food.grams,
                amount: food.amount,
                sourceKind: food.sourceKind,
                nutrition: compactTotals(food.totals, params.nutrition),
              }))
          : undefined,
      })) ?? [],
  };
}

/** Every totals block of a preparation view trimmed to the requested detail. */
export function mealPreparations(
  view: Awaited<ReturnType<typeof getMealPreparations>>,
  nutrition: MealPreparationNutritionDetail,
) {
  const project = trimNutrition(nutrition);
  return {
    mealId: view.mealId,
    preparations: view.preparations.map((preparation) => ({
      ...preparation,
      totals: project(preparation.totals),
      portions: preparation.portions.map((portion) => ({
        ...portion,
        totals: project(portion.totals),
      })),
    })),
    totals: {
      confirmed: {
        ...view.totals.confirmed,
        totals: project(view.totals.confirmed.totals),
      },
      projected: {
        ...view.totals.projected,
        totals: project(view.totals.projected.totals),
      },
    },
  };
}

/** Compact meal identity and cost/kcal coverage, plus the requested nutrients. */
export function addedMealRecipe(
  result: Awaited<ReturnType<typeof addRecipeToMealWorkflow>>,
  nutrition: z.output<typeof addRecipeNutritionDetail>,
) {
  const meal = slimMeal(result.meal);
  const keys =
    nutrition === "full"
      ? nutrientKey.options
      : nutrition === "macros"
        ? macroKeys
        : nutrition === "kcal"
          ? (["kcal"] as const)
          : [];
  return {
    id: meal.id,
    mealRecipeId: result.mealRecipeId,
    name: meal.name ?? meal.mealType ?? meal.date,
    coverage: {
      cost: compactValue(meal.totals.cost),
      kcal: compactValue(meal.totals.nutrition.kcal),
    },
    nutrition:
      keys.length > 0
        ? Object.fromEntries(
            keys.map((key) => [key, compactValue(meal.totals.nutrition[key])]),
          )
        : undefined,
  };
}
