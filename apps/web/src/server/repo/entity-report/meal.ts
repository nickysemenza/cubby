import type {
  ReportBlock,
  ReportCommand,
  ReportCommandInput,
} from "@cubby/schemas/entity-report";
import { mealShortcode } from "@cubby/schemas/identifiers";
import type { MealRecipePreparationOut } from "@cubby/schemas/meal";
import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";

import { formatEstimate } from "~/lib/nutrition-format";
import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import { getMealByID } from "~/server/repo/meal/crud";
import { getMealPreparations } from "~/server/repo/meal/portions";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import type { RequestServices } from "~/server/request-services";

type Records = Extract<ReportBlock, { kind: "records" }>;
type Row = Records["rows"][number];
type Services = RequestServices["services"];

const scaleInput = (initial: number): ReportCommandInput => ({
  kind: "number",
  key: "scale",
  label: "Recipe scale",
  initial,
  min: 0.01,
});

/** "1 serving", "250 g": the amount as the person entered it. */
const amountText = (amount: { value: number; unit: string }) =>
  `${amount.value} ${amount.unit}${amount.unit === "serving" && amount.value !== 1 ? "s" : ""}`;

const targetLabel = (target: { name: string | null; date: string }) =>
  target.name ?? target.date;

/** The units a portion of this recipe can be entered in: its yield's, servings, and grams. */
const portionUnits = (preparation: MealRecipePreparationOut) => {
  const units = [
    ...(preparation.recipeServings !== null ? ["serving"] : []),
    ...(preparation.recipeYield ? [preparation.recipeYield.unit] : []),
    "g",
  ];
  return [...new Set(units)].map((unit) => ({ value: unit, label: unit }));
};

/**
 * A meal's composition: the recipes it serves, each with the commands that change it, then each
 * prepared recipe's portions. The server composes every row's wording and every command's exact
 * request (`meal.addRecipe`, `updateRecipe`, `removeRecipe`, `savePreparation`); what a person
 * enters (scale, recipe, eater, amount, yield) is a declared input, never a guess. Foods that are
 * not recipes, leftovers from another meal, and the per-person nutrition stay with the meal's
 * other sections.
 */
export async function mealCompositionReport(
  db: Database,
  code: string,
  services: Services,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "meal", code);
  // SAFETY: `resolveOrThrow` just resolved a live meal, so the read cannot miss.
  const meal = (await getMealByID(db, id))!;
  const mealId = mealShortcode.parse(code);
  // The same recipe can be served twice; number the repeats like the web list.
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const entry of meal.recipes)
    total.set(entry.recipeId, (total.get(entry.recipeId) ?? 0) + 1);
  const nameOf = (entry: (typeof meal.recipes)[number]) => {
    const ordinal = (seen.get(entry.recipeId) ?? 0) + 1;
    seen.set(entry.recipeId, ordinal);
    return (total.get(entry.recipeId) ?? 0) > 1
      ? `${entry.recipe.name} · ${ordinal}`
      : entry.recipe.name;
  };

  const recipes: Records = {
    kind: "records",
    title: "Recipes",
    rows: meal.recipes.map((entry): Row => {
      const name = nameOf(entry);
      return {
        entity: "recipe",
        id: entry.recipe.id,
        title: name,
        subtitle: `×${entry.scale} · ${formatEstimate(entry.scaledTotals.cost, (value) => formatCurrency(value))}`,
        trailing: null,
        key: entry.id,
        commands: [
          {
            id: `scale:${entry.id}`,
            label: "Change scale",
            prominent: false,
            confirm: null,
            inputs: [scaleInput(entry.scale)],
            request: {
              kind: "meal-scale-recipe",
              mealRecipeId: entry.id,
              scale: null,
            },
          },
          {
            id: `remove:${entry.id}`,
            label: "Remove",
            prominent: false,
            confirm: `Remove ${name} from this meal?`,
            request: { kind: "meal-remove-recipe", mealRecipeId: entry.id },
          },
        ],
      };
    }),
    empty:
      meal.mealKind === "cooked"
        ? "No recipes yet. Add food when you're ready to plan or log this meal."
        : meal.mealKind === "leftovers"
          ? "No new recipes. Add leftovers from another meal."
          : `${MEAL_KIND_LABELS[meal.mealKind]} — no recipe required.`,
    commands:
      meal.mealKind === "cooked" || meal.mealKind === "leftovers"
        ? [
            {
              id: "add-recipe",
              label: "Add recipe",
              prominent: true,
              confirm: null,
              inputs: [
                {
                  kind: "record",
                  key: "recipeId",
                  label: "Recipe",
                  entity: "recipe",
                },
                { ...scaleInput(1) },
              ],
              request: {
                kind: "meal-add-recipe",
                mealId,
                recipeId: null,
                scale: null,
              },
            },
          ]
        : [],
  };

  const { preparations } = await getMealPreparations(
    db,
    { mealId },
    services.recipeCosting,
  );
  return [
    recipes,
    ...preparations.flatMap((entry) => portionBlocks(entry, mealId)),
  ];
}

/** One prepared recipe's portions, how much of the batch they account for, and what to add. */
function portionBlocks(
  preparation: MealRecipePreparationOut,
  mealId: ReturnType<typeof mealShortcode.parse>,
): ReportBlock[] {
  const { mealRecipeId } = preparation;
  const summary = preparation.sourceSummary;
  const overAssigned = (summary?.unassignedGrams ?? 0) < 0;
  const block: Records = {
    kind: "records",
    title: `Portions · ${preparation.recipe.name}`,
    rows: preparation.portions.map((portion): Row => {
      const eaten = portion.confirmedAt !== null;
      const target = {
        mealRecipeId,
        mealId: portion.targetMeal.id,
      };
      return {
        entity: null,
        id: null,
        title: portion.eater.name,
        subtitle: [
          amountText(portion.amount),
          portion.servedHere ? "this meal" : targetLabel(portion.targetMeal),
        ].join(" · "),
        trailing: null,
        key: `${portion.targetMeal.id}:${portion.eater.id}`,
        statuses: [
          eaten
            ? { label: "Eaten", tone: "positive" }
            : { label: "Planned", tone: "muted" },
        ],
        commands: [
          {
            id: `portion-status:${portion.targetMeal.id}:${portion.eater.id}`,
            label: eaten ? "Mark planned" : "Mark eaten",
            prominent: false,
            confirm: null,
            request: {
              kind: "meal-portion-set",
              ...target,
              ledgerPartyId: portion.eater.id,
              value: portion.amount.value,
              unit: portion.amount.unit,
              confirmed: !eaten,
            },
          },
          {
            id: `portion-remove:${portion.targetMeal.id}:${portion.eater.id}`,
            label: "Remove portion",
            prominent: false,
            confirm: `Remove ${portion.eater.name}'s portion of ${preparation.recipe.name}?`,
            request: {
              kind: "meal-portion-remove",
              ...target,
              ledgerPartyId: portion.eater.id,
            },
          },
        ],
      };
    }),
    empty: "No portions yet.",
    commands: [
      ...(preparation.preparedHere
        ? [
            {
              id: `portion-add:${mealRecipeId}`,
              label: "Add portion",
              prominent: true,
              confirm: null,
              inputs: [
                {
                  kind: "record",
                  key: "ledgerPartyId",
                  label: "Eater",
                  entity: "ledgerParty",
                },
                {
                  kind: "number",
                  key: "value",
                  label: "Amount",
                  initial: 1,
                  min: 0.01,
                },
                {
                  kind: "choice",
                  key: "unit",
                  label: "Unit",
                  options: portionUnits(preparation),
                  initial: portionUnits(preparation)[0]?.value ?? null,
                },
              ],
              request: {
                kind: "meal-portion-set",
                mealRecipeId,
                mealId,
                ledgerPartyId: null,
                value: null,
                unit: null,
                confirmed: false,
              },
            } satisfies ReportCommand,
          ]
        : []),
      {
        id: `yield:${mealRecipeId}`,
        label: "Set actual yield",
        prominent: false,
        confirm: null,
        inputs: [
          {
            kind: "number",
            key: "grams",
            label: "Made (g)",
            initial: preparation.actualYieldGrams,
            min: 1,
          },
        ],
        request: {
          kind: "meal-yield",
          mealRecipeId,
          field: "actual",
          grams: null,
        },
      },
    ],
  };
  if (summary?.unassignedGrams != null)
    block.footer = overAssigned
      ? `Over-assigned by ${Math.round(-summary.unassignedGrams)} g of the batch.`
      : `${Math.round(summary.unassignedGrams)} g of the batch unassigned.`;
  return [block];
}
