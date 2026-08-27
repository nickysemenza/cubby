import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  enrichmentWorkbenchInput,
  ingredientIdInput,
  ingredientIdsInput,
  ingredientMergeInput,
  ingredientMergeOut,
  ingredientNameFilterInput,
  ingredientNamesInput,
  ingredientOut,
  ingredientResolvableNamesInput,
} from "@cubby/schemas/ingredient";
import type { z } from "zod";
import type { Database } from "~/server/db";
import { executeEntity } from "~/server/entity-kernel";
import {
  getIngredientMatches,
  getRecipeUsagesForIngredient,
  resolveOrCreateIngredients,
} from "~/server/repo/ingredient";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  enrichmentWorkbench as enrichmentWorkbenchService,
  getIngredientByName,
  getIngredientsByIDs,
} from "~/server/services/ingredient.service";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

export {
  enrichmentWorkbenchInput,
  ingredientIdInput,
  ingredientIdsInput,
  ingredientMergeInput,
  ingredientNameFilterInput,
  ingredientNamesInput,
  ingredientResolvableNamesInput,
};

const ingredients = bindShortcodeResolver("ingredient");
const recipes = bindShortcodeResolver("recipe");
export const getByNameWorkflow = (
  db: Database,
  usdaClient: Parameters<typeof getIngredientByName>[1],
  input: z.input<typeof ingredientNameFilterInput>,
) => getIngredientByName(db, usdaClient, input.nameFilter);
export const matchNamesWorkflow = (
  db: Database,
  input: z.input<typeof ingredientNamesInput>,
) => getIngredientMatches(db, input.names);
export const getManyByIDsWorkflow = async (
  db: Database,
  usdaClient: Parameters<typeof getIngredientsByIDs>[1],
  input: z.input<typeof ingredientIdsInput>,
) => getIngredientsByIDs(db, usdaClient, await ingredients.all(db, input.ids));
export const recipeUsagesWorkflow = async (
  db: Database,
  input: z.input<typeof ingredientIdInput>,
) =>
  (await getRecipeUsagesForIngredient(db, await ingredients.one(db, input.id)))
    .recipeUsages;
export const enrichmentWorkbenchWorkflow = async (
  db: Database,
  usdaClient: Parameters<typeof enrichmentWorkbenchService>[1],
  input: z.input<typeof enrichmentWorkbenchInput>,
) =>
  enrichmentWorkbenchService(db, usdaClient, {
    recipeId: input?.recipeId
      ? await recipes.one(db, input.recipeId)
      : undefined,
    focusId: input?.focusId
      ? await ingredients.one(db, input.focusId)
      : undefined,
    focusShortcode: input?.focusId
      ? parseShortcodeFor("ingredient", input.focusId)
      : undefined,
  });
export const resolveOrCreateWorkflow = async (
  db: Database,
  input: z.input<typeof ingredientResolvableNamesInput>,
) => {
  const result = await resolveOrCreateIngredients(db, input.names);
  const created = result.filter((ingredient) => ingredient.created);
  await runMutationSideEffectsForEntities(
    db,
    created.map((ingredient) => ({
      action: "created" as const,
      entity: {
        entityType: "ingredient" as const,
        entityId: parseEntityId("ingredient", ingredient.entityId),
      },
      source: "ingredient.resolveOrCreate",
    })),
  );
  return result;
};
export const mergeWorkflow = async (
  context: Parameters<typeof executeEntity>[0],
  input: z.input<typeof ingredientMergeInput>,
) => {
  const result = await executeEntity(context, {
    action: "merge",
    entity: "ingredient",
    data: input,
  });
  if (result.action !== "merge")
    throw new Error("Entity kernel returned the wrong action");
  return {
    ingredient: ingredientOut.parse(result.item),
    mergeSummary: ingredientMergeOut.shape.mergeSummary.parse(
      result.mergeSummary,
    ),
    sideEffects: result.sideEffects,
  };
};
