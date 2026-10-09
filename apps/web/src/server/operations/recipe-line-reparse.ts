import type { RecipeShortcode } from "@cubby/schemas/identifiers";

import { computeParseDrift } from "~/lib/parse-drift";
import { wasm } from "~/lib/wasm";
import {
  type EntityKernelContext,
  executeEntityAs,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";

import { resolveOrCreateIngredients } from "./ingredient.server";
import { patchRecipeLine, type RecipeLinePatch } from "./recipe-line-patch";

/**
 * Re-parse one stored recipe line with the current parser and write what changed.
 *
 * The one rule behind every "Re-parse" (web's usage table, native's report row): the line's source
 * text is parsed, compared to what is stored on three axes (amount, modifier, name), a drifted
 * name goes through find-or-create (the same resolution a Problems batch re-parse uses) so the
 * line points at a real ingredient, and only the drifted axes are written. A parse that drifted to
 * no amount leaves the stored amount alone: a line patch cannot clear amounts.
 */
export async function reparseRecipeLine(
  context: EntityKernelContext,
  input: { recipeId: RecipeShortcode; lineId: string },
) {
  const detail = await executeEntityAs(context, "get", {
    entity: "recipe",
    id: input.recipeId,
    missing: "error",
  });
  const line = detail.item?.sections
    .flatMap((section) => section.ingredients)
    .find((candidate) => candidate.id === input.lineId);
  if (!line)
    throw createAppError(
      "RECIPE_NOT_FOUND",
      `Line ${input.lineId} is not in recipe ${input.recipeId}`,
    );
  if (!line.rawLine)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "This line has no source line to re-parse",
    );
  if (line.ingredient === null)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A sub-recipe line has no ingredient name to re-parse",
    );
  const drift = computeParseDrift(
    {
      knownNames: [line.ingredient.name, ...(line.ingredient.aliases ?? [])],
      amounts: line.amounts,
      modifier: line.modifier ?? null,
    },
    wasm.parse_ingredient(line.rawLine),
  );

  const freshAmounts =
    drift.amounts?.filter((amount) => amount.value > 0) ?? [];
  const patch: RecipeLinePatch = {};
  if (freshAmounts.length > 0)
    patch.amounts = freshAmounts.map((amount) => ({
      value: amount.value,
      unit: amount.unit,
      ...(amount.upper_value != null && { upperValue: amount.upper_value }),
    }));
  if (drift.modifier !== null) patch.modifier = drift.modifier;
  if (drift.name !== null) {
    const [resolved] = await resolveOrCreateIngredients(context, [drift.name]);
    if (resolved) patch.ingredientId = resolved.id;
  }
  const changed = [
    ...(patch.amounts ? (["amount"] as const) : []),
    ...(patch.modifier !== undefined ? (["modifier"] as const) : []),
    ...(patch.ingredientId ? (["name"] as const) : []),
  ];
  if (changed.length === 0)
    return { recipeId: input.recipeId, status: "unchanged" as const, changed };
  await patchRecipeLine(context, {
    recipeId: input.recipeId,
    lineId: input.lineId,
    patch,
  });
  return { recipeId: input.recipeId, status: "updated" as const, changed };
}
