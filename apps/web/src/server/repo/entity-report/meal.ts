import type { ReportBlock } from "@cubby/schemas/entity-report";
import { MEAL_KIND_LABELS } from "@cubby/schemas/meal-classification";

import { formatEstimate } from "~/lib/nutrition-format";
import { formatCurrency } from "~/lib/utils";
import type { Database } from "~/server/db";
import { getMealByID } from "~/server/repo/meal/crud";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

/** The meal's served recipes with scale and scaled cost; edits stay on web. */
export async function mealCompositionReport(
  db: Database,
  code: string,
): Promise<ReportBlock[]> {
  const id = await resolveOrThrow(db, "meal", code);
  // SAFETY: `resolveOrThrow` just resolved a live meal, so the read cannot miss.
  const meal = (await getMealByID(db, id))!;
  // The same recipe can be served twice; number the repeats like the web list.
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const entry of meal.recipes)
    total.set(entry.recipeId, (total.get(entry.recipeId) ?? 0) + 1);
  return [
    {
      kind: "table",
      columns: ["Recipe", "Scale", "Cost"],
      rows: meal.recipes.map((entry) => {
        const ordinal = (seen.get(entry.recipeId) ?? 0) + 1;
        seen.set(entry.recipeId, ordinal);
        return {
          id: entry.id,
          cells: [
            (total.get(entry.recipeId) ?? 0) > 1
              ? `${entry.recipe.name} · ${ordinal}`
              : entry.recipe.name,
            `×${entry.scale}`,
            formatEstimate(entry.scaledTotals.cost, (value) =>
              formatCurrency(value),
            ),
          ],
          ref: { entity: "recipe" as const, id: entry.recipe.id },
        };
      }),
      empty:
        meal.mealKind === "cooked"
          ? "No recipes yet. Add food when you're ready to plan or log this meal."
          : meal.mealKind === "leftovers"
            ? "No new recipes. Add leftovers from another meal."
            : `${MEAL_KIND_LABELS[meal.mealKind]} — no recipe required.`,
    },
  ];
}
