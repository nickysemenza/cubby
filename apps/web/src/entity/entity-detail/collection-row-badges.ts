import type { ReportRecordRow } from "@cubby/schemas/entity-report";
import { recipeUsageOut } from "@cubby/schemas/recipe";
import { compareRecipeUsages } from "@cubby/schemas/recipe-usage-order";
import { z } from "zod";

import { computeParseDrift } from "~/lib/parse-drift";
import { wasm } from "~/lib/wasm";

const ingredientUsages = z.looseObject({
  recipeUsages: z.array(recipeUsageOut),
  ingredient: z
    .looseObject({ name: z.string(), aliases: z.array(z.string()).optional() })
    .nullable(),
});

export type DriftRecord = z.output<typeof ingredientUsages>;

/**
 * Re-parses each stored recipe line with the current parser and names the axes that would
 * change (amount, modifier, name). The rows arrive in `compareRecipeUsages` order, so the badge
 * for row `i` is the one for the `i`th sorted usage; a record whose lines do not line up with
 * its rows gets no badges rather than the wrong ones.
 */
export const parseDrift = (
  record: DriftRecord,
  items: readonly ReportRecordRow[],
): (string | null)[] => {
  if (record.ingredient === null) return [];
  const { ingredient } = record;
  const usages = [...record.recipeUsages].sort(compareRecipeUsages);
  if (usages.length !== items.length) return [];
  const knownNames = [ingredient.name, ...(ingredient.aliases ?? [])];
  // One batch WASM call for the table; output order matches input.
  const fresh = wasm.parse_ingredient_lines(
    usages.map((usage) => usage.rawLine ?? ""),
  );
  return usages.map((usage, index) => {
    if (!usage.rawLine) return null;
    const drift = computeParseDrift(
      { knownNames, amounts: usage.amounts, modifier: usage.modifier ?? null },
      fresh[index]!,
    );
    const axes = [
      drift.amounts !== null ? "amount" : null,
      drift.modifier !== null ? "modifier" : null,
      drift.name !== null ? "name" : null,
    ].filter((axis) => axis !== null);
    return axes.length > 0 ? `Re-parse changes ${axes.join(", ")}` : null;
  });
};
