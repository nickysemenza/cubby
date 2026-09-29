import {
  parseEntityId,
  parseShortcodeFor,
  type ProductShortcode,
} from "@cubby/schemas/identifiers";
import {
  type ingredientIdInput,
  ingredientMergeOut,
  type ingredientMergeInput,
  ingredientOut,
  type ingredientResolvableNamesInput,
} from "@cubby/schemas/ingredient";
import type { z } from "zod";

import { ingredientContract } from "~/contracts/ingredient.contract";
import type { Database } from "~/server/db";
import {
  type EntityKernelContext,
  executeEntity,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { withTransaction } from "~/server/repo/database-helpers";
import {
  getIngredientMatches,
  getRecipeUsagesForIngredient,
  resolveOrCreateIngredients,
} from "~/server/repo/ingredient";
import { findUnlinkedProductCandidates } from "~/server/repo/ingredient/crud";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  enrichmentWorkbench,
  getIngredientByName,
  getIngredientsByIDs,
} from "~/server/services/ingredient.service";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

const ingredients = bindShortcodeResolver("ingredient");
const recipes = bindShortcodeResolver("recipe");

export async function recipeUsagesWorkflow(
  db: Database,
  input: z.input<typeof ingredientIdInput>,
) {
  const ingredientId = await ingredients.one(db, input.id);
  return (await getRecipeUsagesForIngredient(db, ingredientId)).recipeUsages;
}

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
);

/**
 * The agent-facing `entity.resolve` for ingredients: the plain resolve plus,
 * per ingredient, live Products with no ingredient link that read as its
 * name. `linkProductId` links one such Product to the single resolved
 * ingredient through the normal Product update, so costing staleness and
 * embedding refresh fire exactly as for any other edit; candidates are read
 * after the link, so the linked Product no longer appears.
 */
export async function resolveWithProductCandidatesWorkflow(
  context: EntityKernelContext,
  input: ResolveInput & { linkProductId?: ProductShortcode },
) {
  const nameCount = input.names.filter((name) => name.trim() !== "").length;
  if (input.linkProductId !== undefined && nameCount !== 1)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `linkProductId links one Product to one ingredient: pass exactly one non-blank name (got ${nameCount}).`,
    );
  const resolved = await resolveOrCreateWorkflow(context.db, {
    names: input.names,
  });
  const [only] = resolved;
  let linkedProduct: { id: ProductShortcode } | undefined;
  if (input.linkProductId !== undefined && only) {
    await executeEntity(context, {
      action: "update",
      entity: "product",
      id: input.linkProductId,
      data: { ingredientId: only.id },
    });
    linkedProduct = { id: input.linkProductId };
  }
  const candidates = await findUnlinkedProductCandidates(
    context.db,
    resolved.map(({ id, canonicalName }) => ({ id, name: canonicalName })),
  );
  return resolved.map((ingredient) => ({
    ...ingredient,
    candidateProducts: candidates.get(ingredient.id) ?? [],
    ...(linkedProduct && { linkedProduct }),
  }));
}

export async function mergeWorkflow(
  context: Parameters<typeof executeEntity>[0],
  input: z.input<typeof ingredientMergeInput>,
) {
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
}

export const ingredientHandlers = implementOperationDomain(ingredientContract, {
  getByName: (context, input) =>
    getIngredientByName(context.db, context.usdaClient, input.nameFilter),
  matchNames: (context, input) => getIngredientMatches(context.db, input.names),
  getManyByIDs: async (context, input) =>
    getIngredientsByIDs(
      context.db,
      context.usdaClient,
      await ingredients.all(context.db, input.ids),
    ),
  recipeUsages: (context, input) => recipeUsagesWorkflow(context.db, input),
  resolveOrCreate: (context, input) =>
    resolveOrCreateWorkflow(context.db, input),
  enrichmentWorkbench: async (context, input) =>
    enrichmentWorkbench(context.db, context.usdaClient, {
      recipeId: input?.recipeId
        ? await recipes.one(context.db, input.recipeId)
        : undefined,
      focusId: input?.focusId
        ? await ingredients.one(context.db, input.focusId)
        : undefined,
      focusShortcode: input?.focusId
        ? parseShortcodeFor("ingredient", input.focusId)
        : undefined,
    }),
  merge: (context, input) => mergeWorkflow(context, input),
});
