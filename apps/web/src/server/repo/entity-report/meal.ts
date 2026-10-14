import type {
  ReportBlock,
  ReportCommand,
  ReportCommandInput,
} from "@cubby/schemas/entity-report";
import { mealShortcode } from "@cubby/schemas/identifiers";
import {
  MEAL_PORTIONS_BLOCK_KEY,
  type MealRecipePreparationOut,
} from "@cubby/schemas/meal";
import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";
import { hasKnownEstimate } from "@cubby/schemas/nutrition";
import { countLabel } from "@cubby/shared/pluralize";
import { and, asc, inArray } from "drizzle-orm";

import { formatCount } from "~/lib/number-format";
import { formatEstimate } from "~/lib/nutrition-format";
import type { Database } from "~/server/db";
import { ledgerParty } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
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
  amount.unit === "serving"
    ? countLabel(amount.value, "serving")
    : `${amount.value} ${amount.unit}`;

const targetLabel = (target: { name: string | null; date: string }) =>
  target.name ?? target.date;

type Preparation = MealRecipePreparationOut;
type Portion = Preparation["portions"][number];

/** "200 g · 40% of batch": what a portion weighs and how much of the batch it takes, when known. */
const portionEstimate = (portion: Portion) => {
  const parts = [
    ...(portion.grams !== null
      ? [`${formatCount(portion.grams, 2)} g`]
      : hasKnownEstimate(portion.weight)
        ? [formatEstimate(portion.weight, "macro", "g")]
        : []),
    ...(hasKnownEstimate(portion.batchShare)
      ? [`${formatEstimate(portion.batchShare, "share")} of batch`]
      : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : "weight unknown";
};

const yieldText = (basis: Preparation["yieldBasis"]) => {
  switch (basis.kind) {
    case "actual":
      return `${basis.lowerGrams} g made`;
    case "estimated":
      return `${basis.lowerGrams} g estimated`;
    case "recipe":
      return `${basis.lowerGrams} g recipe yield`;
    case "missing":
      return "Yield needed";
  }
};

/** How much of a batch made here its portions account for, and what is left. */
const assignedText = (summary: NonNullable<Preparation["sourceSummary"]>) => {
  const assigned =
    summary.assignedGrams !== null
      ? `${formatCount(summary.assignedGrams, 1)} g assigned`
      : summary.assignedShare.status === "complete" ||
          summary.assignedShare.status === "partial"
        ? `${formatEstimate(summary.assignedShare, "share")} of batch assigned`
        : "assigned weight unknown";
  const left =
    summary.unassignedGrams === null
      ? "remainder unknown"
      : summary.unassignedGrams < 0
        ? `over-assigned by ${Math.round(-summary.unassignedGrams)} g`
        : `${Math.round(summary.unassignedGrams)} g unassigned`;
  return `${assigned} · ${left}`;
};

/** The units a portion of this recipe can be entered in: its yield's, servings, and grams. */
const portionUnits = (preparation: Preparation) => {
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
        subtitle: `×${entry.scale} · ${formatEstimate(entry.scaledTotals.cost, "cost")}`,
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
    commands: [
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
          scaleInput(1),
          // A recipe on a meal that is not cooked yet converts it, so the person reviews that.
          ...(meal.mealKind === "cooked"
            ? []
            : [
                {
                  kind: "choice" as const,
                  key: "convertToCooked",
                  label: "This meal is not cooked yet",
                  options: [
                    { value: "true", label: "Switch this meal to cooked" },
                    { value: "false", label: "Keep it as it is" },
                  ],
                  initial: "true",
                },
              ]),
        ],
        request: {
          kind: "meal-add-recipe",
          mealId,
          recipeId: null,
          scale: null,
          convertToCooked: meal.mealKind === "cooked" ? false : null,
        },
      },
    ],
  };

  const { preparations } = await getMealPreparations(
    db,
    { mealId },
    services.recipeCosting,
  );
  // Members and guests can eat; Add portion offers only those without a portion on this meal yet,
  // so it can never replace one silently (changing a portion is Mark eaten/planned or Remove).
  const parties = await getDb(db)
    .select({ code: ledgerParty.shortcode, name: ledgerParty.name })
    .from(ledgerParty)
    .where(
      and(
        inArray(ledgerParty.kind, ["member", "guest"]),
        notDeleted(ledgerParty),
      ),
    )
    .orderBy(asc(ledgerParty.name));
  return [
    recipes,
    ...preparations.flatMap((entry) => {
      const taken = new Set<string>(
        entry.portions
          .filter((portion) => portion.targetMeal.id === mealId)
          .map((portion) => portion.eater.id),
      );
      return portionBlocks(
        entry,
        mealId,
        parties
          .filter((party) => !taken.has(party.code))
          .map((party) => ({ value: party.code, label: party.name })),
      );
    }),
  ];
}

/** One prepared recipe's portions, how much of the batch they account for, and what to add. */
function portionBlocks(
  preparation: Preparation,
  mealId: ReturnType<typeof mealShortcode.parse>,
  freeEaters: readonly { value: string; label: string }[],
): ReportBlock[] {
  const { mealRecipeId } = preparation;
  const summary = preparation.sourceSummary;
  const block: Records = {
    kind: "records",
    key: `${MEAL_PORTIONS_BLOCK_KEY}${mealRecipeId}`,
    presentation: "ledger",
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
          portionEstimate(portion),
          ...(portion.servedHere
            ? []
            : [`for ${targetLabel(portion.targetMeal)}`]),
        ].join(" · "),
        trailing: null,
        key: `${portion.targetMeal.id}:${portion.eater.id}`,
        state: eaten
          ? { kind: "done", label: "Eaten" }
          : { kind: "not_reached", label: "Planned" },
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
    // An empty ledger drops its title, so the empty copy names the recipe.
    empty: `No one has a portion of ${preparation.recipe.name} yet.`,
    // A batch made here has a source summary; leftovers name the meal that made them.
    footer: [
      yieldText(preparation.yieldBasis),
      summary
        ? assignedText(summary)
        : `From ${targetLabel(preparation.sourceMeal)}`,
    ].join(" · "),
    commands: [
      ...(preparation.preparedHere && freeEaters.length > 0
        ? [
            {
              id: `portion-add:${mealRecipeId}`,
              label: "Add portion",
              prominent: true,
              confirm: null,
              inputs: [
                {
                  kind: "choice",
                  key: "ledgerPartyId",
                  label: "Eater",
                  options: [...freeEaters],
                  initial: null,
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
  return [block];
}
