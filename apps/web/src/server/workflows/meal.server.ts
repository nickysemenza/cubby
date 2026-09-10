import type {
  AggregatedNeed,
  BlockedSubRecipe,
} from "@cubby/schemas/availability";
import type { MealId } from "@cubby/schemas/identifiers";
import type {
  GetMealPreparationsInput,
  SaveMealRecipePreparationInput,
  mealAddRecipeInput,
  shoppingListInput,
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
import {
  callStep,
  defineWorkflow,
  defineWorkflowFunction,
  defineWorkflowOperation,
  bindWorkflow,
  workflow,
  workflowInput,
  type WorkflowFunctionContext,
} from "~/server/workflow-runtime";

const mealShortcodes = bindShortcodeResolver("meal");

const refreshMealEmbedding = (db: Database, id: MealId, source: string) =>
  runMutationSideEffects(db, {
    action: "updated",
    entity: { entity: "meal", id: id },
    source,
  });

export const getMealsByDateRangeWorkflow = defineWorkflowOperation(
  "meal.getByDateRange",
  (db: Database, input: { from: string; to: string }) =>
    getMealsByDateRange(db, input.from, input.to),
);
export const getUpcomingMealSummaryWorkflow = defineWorkflowOperation(
  "meal.upcomingSummary",
  (db: Database, input: { from: string; to: string }) =>
    getUpcomingMealSummary(db, input.from, input.to),
);
export const getMealPreparationsWorkflow = defineWorkflowOperation(
  "meal.getPreparations",
  (db: Database, input: GetMealPreparationsInput) =>
    getMealPreparations(db, input),
);

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
  (
    db: Database,
    input: SaveMealRecipePreparationInput,
    actorContext: MealMutationContext["actorContext"],
  ) => ({ context: { db, actorContext }, input }),
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
  (
    db: Database,
    input: typeof mealAddRecipeInput._output,
    actorContext: MealMutationContext["actorContext"],
  ) => ({ context: { db, actorContext }, input }),
);

export const updateMealRecipeWorkflow = bindWorkflow(
  workflow<MealMutationContext, typeof mealUpdateRecipeInput._output>(
    "meal.updateRecipe",
  )
    .commit(
      "updated",
      async ({ context }, { input }) =>
        (
          await updateMealRecipeWithEntityId(
            context.db,
            input.id,
            { scale: input.scale, sortOrder: input.sortOrder },
            context.actorContext,
          )
        ).output,
    )
    .output(({ updated }) => updated),
  (
    db: Database,
    input: typeof mealUpdateRecipeInput._output,
    actorContext: MealMutationContext["actorContext"],
  ) => ({ context: { db, actorContext }, input }),
);

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
  (
    db: Database,
    input: typeof mealRecipeIdInput._output,
    actorContext: MealMutationContext["actorContext"],
  ) => ({ context: { db, actorContext }, input }),
);

type ShoppingInput = typeof shoppingListInput._output;
type ShoppingContext = {
  db: Database;
  availability: Pick<AvailabilityService, "getAggregatedNeeds">;
};

const loadShoppingMeals = defineWorkflowFunction(
  "meal.loadShoppingMeals",
  async (
    { context }: WorkflowFunctionContext<ShoppingContext>,
    input: ShoppingInput,
  ) => ({
    input,
    meals: await getMealsByDateRange(context.db, input.from, input.to),
  }),
);

const selectShoppingRequirements = defineWorkflowFunction(
  "meal.selectShoppingRequirements",
  async (
    _execution: WorkflowFunctionContext<ShoppingContext>,
    { input, meals }: Awaited<ReturnType<typeof loadShoppingMeals.run>>,
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
  },
);

const aggregateShoppingRequirements = defineWorkflowFunction(
  "meal.aggregateShoppingRequirements",
  async (
    { context }: WorkflowFunctionContext<ShoppingContext>,
    selected: Awaited<ReturnType<typeof selectShoppingRequirements.run>>,
  ) => ({
    ...selected,
    ...(await context.availability.getAggregatedNeeds(selected.publicLines)),
  }),
);

const presentShoppingRequirements = defineWorkflowFunction(
  "meal.presentShoppingRequirements",
  async (
    _execution: WorkflowFunctionContext<ShoppingContext>,
    {
      input,
      cookedMeals,
      omittedMeals,
      lineMeta,
      needs,
      unexpanded,
    }: Awaited<ReturnType<typeof aggregateShoppingRequirements.run>>,
  ) => {
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
          (b.shortfall ?? 0) - (a.shortfall ?? 0) ||
          a.name.localeCompare(b.name),
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
  },
);

const shoppingMeals = callStep({
  name: "meals",
  fn: loadShoppingMeals,
  input: workflowInput<ShoppingInput>(),
});
const shoppingSelection = callStep({
  name: "selection",
  fn: selectShoppingRequirements,
  input: shoppingMeals.output,
});
const shoppingNeeds = callStep({
  name: "requirements",
  fn: aggregateShoppingRequirements,
  input: shoppingSelection.output,
});
const shoppingResult = callStep({
  name: "shopping",
  fn: presentShoppingRequirements,
  input: shoppingNeeds.output,
});

const shoppingWorkflow = defineWorkflow({
  name: "meal.shopping",
  steps: [shoppingMeals, shoppingSelection, shoppingNeeds, shoppingResult],
  output: shoppingResult.output,
});

export const getShoppingListWorkflow = bindWorkflow(
  shoppingWorkflow,
  (
    db: Database,
    input: ShoppingInput,
    availability: ShoppingContext["availability"],
  ) => ({ context: { db, availability }, input }),
);
