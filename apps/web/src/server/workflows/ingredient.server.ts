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
import { withTransaction } from "~/server/repo/database-helpers";
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
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

const ingredients = bindShortcodeResolver("ingredient");
const recipes = bindShortcodeResolver("recipe");
export const getByNameWorkflow = defineWorkflowOperation(
  "ingredient.getByName",
  async (
    db: Database,
    usdaClient: Parameters<typeof getIngredientByName>[1],
    input: z.input<typeof ingredientNameFilterInput>,
  ) => getIngredientByName(db, usdaClient, input.nameFilter),
);
export const matchNamesWorkflow = defineWorkflowOperation(
  "ingredient.matchNames",
  async (db: Database, input: z.input<typeof ingredientNamesInput>) =>
    getIngredientMatches(db, input.names),
);
type IngredientReadContext = {
  db: Database;
  usdaClient: Parameters<typeof getIngredientsByIDs>[1];
};
export const getManyByIDsWorkflow = bindWorkflow(
  workflow<IngredientReadContext, z.input<typeof ingredientIdsInput>>(
    "ingredient.getManyByIDs",
  )
    .call("resolve", async ({ context }, { input }) =>
      ingredients.all(context.db, input.ids),
    )
    .call("read", async ({ context }, { resolve }) =>
      getIngredientsByIDs(context.db, context.usdaClient, resolve),
    )
    .output(({ read }) => read),
  (
    db: Database,
    usdaClient: IngredientReadContext["usdaClient"],
    input: z.input<typeof ingredientIdsInput>,
  ) => ({ context: { db, usdaClient }, input }),
);
export const recipeUsagesWorkflow = bindWorkflow(
  workflow<{ db: Database }, z.input<typeof ingredientIdInput>>(
    "ingredient.recipeUsages",
  )
    .call("resolve", async ({ context }, { input }) =>
      ingredients.one(context.db, input.id),
    )
    .call("read", async ({ context }, { resolve }) =>
      getRecipeUsagesForIngredient(context.db, resolve),
    )
    .output(({ read }) => read.recipeUsages),
  (db: Database, input: z.input<typeof ingredientIdInput>) => ({
    context: { db },
    input,
  }),
);
export const enrichmentWorkbenchWorkflow = bindWorkflow(
  workflow<IngredientReadContext, z.input<typeof enrichmentWorkbenchInput>>(
    "ingredient.enrichmentWorkbench",
  )
    .call("resolve", async ({ context }, { input }) => ({
      recipeId: input?.recipeId
        ? await recipes.one(context.db, input.recipeId)
        : undefined,
      focusId: input?.focusId
        ? await ingredients.one(context.db, input.focusId)
        : undefined,
      focusShortcode: input?.focusId
        ? parseShortcodeFor("ingredient", input.focusId)
        : undefined,
    }))
    .call("read", async ({ context }, { resolve }) =>
      enrichmentWorkbenchService(context.db, context.usdaClient, resolve),
    )
    .output(({ read }) => read),
  (
    db: Database,
    usdaClient: IngredientReadContext["usdaClient"],
    input: z.input<typeof enrichmentWorkbenchInput>,
  ) => ({ context: { db, usdaClient }, input }),
);
type ResolveInput = z.input<typeof ingredientResolvableNamesInput>;
export const resolveOrCreateWorkflow = bindWorkflow(
  workflow<Database, ResolveInput>("ingredient.resolveOrCreate")
    .commit("ingredients", async ({ context }, { input }) =>
      withTransaction(context, (tx) =>
        resolveOrCreateIngredients(tx, input.names),
      ),
    )
    .effect("effects", async ({ context }, { ingredients }) =>
      runMutationSideEffectsForEntities(
        context,
        mutationEvents(
          "ingredient",
          "created",
          ingredients
            .filter((ingredient) => ingredient.created)
            .map((ingredient) =>
              parseEntityId("ingredient", ingredient.entityId),
            ),
          "ingredient.resolveOrCreate",
        ),
      ),
    )
    .output(({ ingredients }) => ingredients),
  (db: Database, input: ResolveInput) => ({ context: db, input }),
);
export const mergeWorkflow = defineWorkflowOperation(
  "ingredient.merge",
  async (
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
  },
);
