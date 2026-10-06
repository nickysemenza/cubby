import {
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
  executeEntityAs,
  resolveEntity,
} from "~/server/entity-kernel";
import { createAppError } from "~/server/errors/app-error";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { findUnlinkedProductCandidates } from "~/server/repo/ingredient/crud";
import {
  getIngredientMatches,
  getRecipeUsagesForIngredient,
} from "~/server/repo/ingredient/search";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  enrichmentWorkbench,
  getIngredientByName,
  getIngredientsByIDs,
} from "~/server/services/ingredient.service";

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

/**
 * Name → ingredient through the kernel `resolve`, creating the misses (an
 * ingredient is just a name). One entry per non-blank name in order; casing
 * variants share one row, and a name matching another ingredient's alias
 * resolves to it. `canonicalName`/`aliases` are the row's own.
 */
export async function resolveOrCreateIngredients(
  context: EntityKernelContext,
  names: readonly string[],
) {
  if (names.length === 0) return [];
  const { items } = await resolveEntity(context, {
    action: "resolve",
    entity: "ingredient",
    names: [...names],
    create: true,
  });
  return items.map(({ id, name, matched, created, matchValues }) => {
    if (id === null)
      throw new Error("A creating resolve returned no ingredient");
    const [canonicalName = name, ...aliases] = matchValues;
    return {
      name,
      id: parseShortcodeFor("ingredient", id),
      canonicalName,
      aliases,
      matched,
      created,
    };
  });
}

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
  const resolved = await resolveOrCreateIngredients(context, input.names);
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
  context: Parameters<typeof executeEntityAs>[0],
  input: z.input<typeof ingredientMergeInput>,
) {
  const result = await executeEntityAs(context, "merge", {
    entity: "ingredient",
    data: input,
  });
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
    resolveOrCreateIngredients(context, input.names),
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
