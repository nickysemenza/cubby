import type {
  CandidateEquivalence,
  EquivalenceReport,
} from "@cubby/schemas/equivalences";
import type { IngredientCooccurrence } from "@cubby/schemas/ingredient-cooccurrence";
import type { IngredientUsage } from "@cubby/schemas/ingredient-usage";
import type {
  recipeCooccurrenceInput,
  recipeCookbookScopeInput,
  recipeIdInput,
  recipeIdsInput,
} from "@cubby/schemas/recipe";
import type { RecipeDependencyGraph } from "@cubby/schemas/recipe-dependency-graph";
import type {
  recipeFlowGenerateInputSchema,
  recipeFlowGetInputSchema,
} from "@cubby/schemas/recipe-flow";
import type {
  makeableRecipesInput,
  recipeAvailabilityInput,
} from "@cubby/schemas/suggestions";
import { uniq } from "es-toolkit";
import pMap from "p-map";
import type { z } from "zod";

import { streamProgress } from "~/lib/bulk-progress";
import { harvestEquivalences } from "~/lib/harvest-equivalences";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { Database } from "~/server/db";
import { getMultiMeasureRecipeIngredients } from "~/server/repo/equivalences";
import {
  duplicateRecipe,
  getAllTags,
  getIngredientCooccurrence,
  getIngredientUsage,
  getRecipeDependencyGraph,
  getRecipesByIDs,
  recipeList,
} from "~/server/repo/recipe";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { getIngredientsByIDs } from "~/server/services/ingredient.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import {
  generateRecipeFlow,
  getRecipeFlowState,
} from "~/server/services/recipe-flow/recipe-flow.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";

const recipeShortcodes = bindShortcodeResolver("recipe");
const cookbookShortcodes = bindShortcodeResolver("cookbook");
const CANDIDATE_CAP = 500;

export const getManyByIDsWorkflow = async (
  db: Database,
  input: typeof recipeIdsInput._output,
) => getRecipesByIDs(db, await recipeShortcodes.all(db, input.ids));

export const getAllTagsWorkflow = (db: Database) => getAllTags(db);

export const duplicateWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: typeof recipeIdInput._output,
) => {
  const sourceId = await recipeShortcodes.one(context.db, input.id);
  const duplicated = await duplicateRecipe(
    context.db,
    sourceId,
    context.actorContext,
  );
  const entityId = await recipeShortcodes.one(context.db, duplicated.id);
  const recipeBatches = await context.services.recipeCosting.dispatchRecompute(
    [entityId],
    { source: "recipe.duplicate", entity: { entityType: "recipe", entityId } },
  );
  const backgroundBatches = await runMutationSideEffects(context.db, {
    action: "created",
    entity: { entity: "recipe", id: entityId },
    source: "recipe.duplicate",
  });
  return {
    ...duplicated,
    sideEffects: {
      backgroundBatches: [...recipeBatches, ...backgroundBatches],
    },
  };
};

export const getIngredientCooccurrenceWorkflow = (
  db: Database,
  input: typeof recipeCooccurrenceInput._output,
): Promise<IngredientCooccurrence> =>
  getIngredientCooccurrence(db, input?.minEdgeWeight ?? 2);

export const getDependencyGraphWorkflow = async (
  db: Database,
  input: typeof recipeCookbookScopeInput._output,
): Promise<RecipeDependencyGraph> =>
  getRecipeDependencyGraph(
    db,
    input?.cookbookId
      ? await cookbookShortcodes.one(db, input.cookbookId)
      : undefined,
  );

export const getIngredientUsageWorkflow = async (
  db: Database,
  input: typeof recipeCookbookScopeInput._output,
): Promise<IngredientUsage> =>
  getIngredientUsage(
    db,
    input?.cookbookId
      ? await cookbookShortcodes.one(db, input.cookbookId)
      : undefined,
  );

export const recomputeOneWorkflow = async (
  db: Database,
  input: typeof recipeIdInput._output,
  costing: AuthenticatedStartOperationContext["services"]["recipeCosting"],
) => ({
  processed: await costing.recompute([
    await recipeShortcodes.one(db, input.id),
  ]),
});

export const recomputeAllDurableWorkflow = (
  costing: AuthenticatedStartOperationContext["services"]["recipeCosting"],
) => streamProgress(costing.recomputeAllQueued(), (result) => result);
export const recomputeStaleDurableWorkflow = (
  costing: AuthenticatedStartOperationContext["services"]["recipeCosting"],
) => streamProgress(costing.recomputeStaleQueued(), (result) => result);

export const dryRunRecomputeTotalsWorkflow = (
  costing: AuthenticatedStartOperationContext["services"]["recipeCosting"],
) => costing.dryRunRecomputeTotals();

export const explainCostingWorkflow = async (
  db: Database,
  input: typeof recipeIdInput._output,
  costing: AuthenticatedStartOperationContext["services"]["recipeCosting"],
) => costing.explainRecipe(await recipeShortcodes.one(db, input.id));

export const getFlowWorkflow = async (
  db: Database,
  input: typeof recipeFlowGetInputSchema._output,
) => getRecipeFlowState(db, await recipeShortcodes.one(db, input.id));

export const generateFlowWorkflow = async (
  db: Database,
  input: typeof recipeFlowGenerateInputSchema._output,
) =>
  generateRecipeFlow(db, {
    ...input,
    id: await recipeShortcodes.one(db, input.id),
  });

const convertWithinKind = (
  value: number,
  fromUnit: string,
  toUnit: string,
): number | null => {
  if (fromUnit === toUnit) return value;
  try {
    const kind = wasm.amount_kind({ value: 1, unit: toUnit });
    const from = wasm.conv_amount_to_kind([], kind, { value, unit: fromUnit });
    const per = wasm.conv_amount_to_kind([], kind, { value: 1, unit: toUnit });
    if (!from || !per || !(per.value > 0) || !Number.isFinite(from.value))
      return null;
    return from.value / per.value;
  } catch {
    return null;
  }
};

export const harvestEquivalencesWorkflow = async (
  db: Database,
  usdaClient: Parameters<typeof getIngredientsByIDs>[1],
): Promise<EquivalenceReport> => {
  const rows = await getMultiMeasureRecipeIngredients(db);
  const candidates = harvestEquivalences(rows, {
    kindOf: (a) => wasm.amount_kind(a),
    convert: convertWithinKind,
  });
  if (candidates.length === 0) return { candidates: [], hiddenCovered: 0 };
  const ingredientIds = uniq(
    candidates.map((candidate) => candidate.ingredientEntityId),
  );
  const ingredients = await getIngredientsByIDs(db, usdaClient, ingredientIds);
  const mappingsById = new Map(
    ingredients.map((ingredient) => [
      ingredient.id,
      getIngredientMappings(ingredient),
    ]),
  );
  const visible: CandidateEquivalence[] = [];
  let hiddenCovered = 0;
  for (const candidate of candidates) {
    const mappings = mappingsById.get(candidate.ingredientId);
    let existing: number | null = null;
    if (mappings?.length) {
      try {
        const kind = wasm.amount_kind({ value: 1, unit: candidate.unitB });
        const converted = wasm.conv_amount_to_kind(mappings, kind, {
          value: 1,
          unit: candidate.unitA,
        });
        if (converted?.value && Number.isFinite(converted.value))
          existing = convertWithinKind(
            converted.value,
            converted.unit,
            candidate.unitB,
          );
      } catch {
        /* no path is a novel equivalence */
      }
    }
    if (existing == null) {
      visible.push(candidate);
      continue;
    }
    const factor = Math.max(
      existing / candidate.medianRatio,
      candidate.medianRatio / existing,
    );
    if (factor <= 1.15) hiddenCovered++;
    else visible.push({ ...candidate, existingRatio: existing });
  }
  return { candidates: visible, hiddenCovered };
};

export const getRecipeAvailabilityWorkflow = (
  recipeId: z.output<typeof recipeAvailabilityInput>["recipeId"],
  availability: Pick<
    AuthenticatedStartOperationContext["services"]["availability"],
    "getRecipeAvailability"
  >,
) => availability.getRecipeAvailability(recipeId);

export const getMakeableWorkflow = async (
  db: Database,
  input: typeof makeableRecipesInput._output,
  availability: Pick<
    AuthenticatedStartOperationContext["services"]["availability"],
    "getRecipeAvailability"
  >,
) => {
  const minCoverage = input.minCoverage ?? 0;
  const limit = input.limit ?? 24;
  const { data: recipes, count } = await recipeList(
    db,
    { excludeSubRecipes: true },
    [{ orderBy: "name", direction: "asc" }],
    { pageIndex: 0, pageSize: CANDIDATE_CAP },
  );
  const availabilities = await pMap(
    recipes,
    (recipe) => availability.getRecipeAvailability(recipe.id),
    { concurrency: 8 },
  );
  return {
    recipes: availabilities
      .filter((availability) => availability.coverage >= minCoverage)
      .sort((a, b) => b.coverage - a.coverage)
      .slice(0, limit),
    truncated: count > CANDIDATE_CAP,
    candidateCap: CANDIDATE_CAP,
  };
};
