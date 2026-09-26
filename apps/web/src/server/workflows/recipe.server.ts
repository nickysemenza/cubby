import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/background-jobs";
import type {
  CandidateEquivalence,
  EquivalenceReport,
} from "@cubby/schemas/equivalences";
import type { RunId, RecipeId } from "@cubby/schemas/identifiers";
import type {
  recipeCooccurrenceInput,
  recipeCookbookScopeInput,
  recipeIdInput,
  recipeIdsInput,
} from "@cubby/schemas/recipe";
import type {
  recipeFlowGenerateInputSchema,
  recipeFlowGetInputSchema,
} from "@cubby/schemas/recipe-flow";
import type {
  makeableRecipesInput,
  recipeAvailabilityInput,
} from "@cubby/schemas/suggestions";
import { uniq } from "es-toolkit";
import type { z } from "zod";

import { harvestEquivalences } from "~/lib/harvest-equivalences";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { Database } from "~/server/db";
import { getMultiMeasureRecipeIngredients } from "~/server/repo/equivalences";
import {
  duplicateRecipe,
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
import {
  bindWorkflow,
  bindCoordinatorStream,
  defineCoordinatorStream,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

const recipeShortcodes = bindShortcodeResolver("recipe");
const cookbookShortcodes = bindShortcodeResolver("cookbook");
const CANDIDATE_CAP = 500;

export const getManyByIDsWorkflow = bindWorkflow(
  workflow<Database, typeof recipeIdsInput._output>("recipe.getManyByIDs")
    .call("ids", async ({ context }, { input }) =>
      recipeShortcodes.all(context, input.ids),
    )
    .call("recipes", async ({ context }, { ids }) =>
      getRecipesByIDs(context, ids),
    )
    .output(({ recipes }) => recipes),
  (db: Database, input: typeof recipeIdsInput._output) => ({
    context: db,
    input,
  }),
);

export const duplicateWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, typeof recipeIdInput._output>(
    "recipe.duplicate",
  )
    .call("sourceId", async ({ context }, { input }) =>
      recipeShortcodes.one(context.db, input.id),
    )
    .commit("duplicated", async ({ context }, { sourceId }) =>
      duplicateRecipe(context.db, sourceId, context.actorContext),
    )
    .effect("entityId", async ({ context }, { duplicated }) =>
      recipeShortcodes.one(context.db, duplicated.id),
    )
    .effect("costing", async ({ context }, { entityId }) => {
      await context.services.recipeCosting.dispatchRecompute([entityId], {
        source: "recipe.duplicate",
        entity: { entityType: "recipe", entityId },
      });
    })
    .effect("background", async ({ context }, { entityId }) =>
      runMutationSideEffects(context.db, {
        action: "created",
        entity: { entity: "recipe", id: entityId },
        source: "recipe.duplicate",
      }),
    )
    .output(({ duplicated }) => ({
      ...duplicated,
      sideEffects: EMPTY_MUTATION_SIDE_EFFECTS,
    })),
  (
    context: AuthenticatedStartOperationContext,
    input: typeof recipeIdInput._output,
  ) => ({ context, input }),
);

export const getIngredientCooccurrenceWorkflow = defineWorkflowOperation(
  "recipe.getIngredientCooccurrence",
  async (db: Database, input: typeof recipeCooccurrenceInput._output) =>
    getIngredientCooccurrence(db, input?.minEdgeWeight ?? 2),
);

const cookbookRead = <Output>(
  name: string,
  read: (
    db: Database,
    id: Parameters<typeof getRecipeDependencyGraph>[1],
  ) => Promise<Output>,
) =>
  bindWorkflow(
    workflow<Database, typeof recipeCookbookScopeInput._output>(name)
      .call("cookbookId", async ({ context }, { input }) =>
        input?.cookbookId
          ? cookbookShortcodes.one(context, input.cookbookId)
          : undefined,
      )
      .call("read", async ({ context }, { cookbookId }) =>
        read(context, cookbookId),
      )
      .output(({ read }) => read),
    (db: Database, input: typeof recipeCookbookScopeInput._output) => ({
      context: db,
      input,
    }),
  );
export const getDependencyGraphWorkflow = cookbookRead(
  "recipe.getDependencyGraph",
  getRecipeDependencyGraph,
);
export const getIngredientUsageWorkflow = cookbookRead(
  "recipe.getIngredientUsage",
  getIngredientUsage,
);

type Costing = AuthenticatedStartOperationContext["services"]["recipeCosting"];
export const recomputeOneWorkflow = bindWorkflow(
  workflow<{ db: Database; costing: Costing }, typeof recipeIdInput._output>(
    "recipe.recomputeOne",
  )
    .call("id", async ({ context }, { input }) =>
      recipeShortcodes.one(context.db, input.id),
    )
    .commit("processed", async ({ context }, { id }) =>
      context.costing.recompute([id]),
    )
    .output(({ processed }) => ({ processed })),
  (db: Database, input: typeof recipeIdInput._output, costing: Costing) => ({
    context: { db, costing },
    input,
  }),
);

type RecipeCostingCoordinatorInput = {
  readonly input: undefined;
  readonly selection: RecipeId[];
};
type RecipeCostingCoordinatorResult = {
  readonly enqueued: number;
  readonly total: number;
};

const recipeCostingCoordinator = (
  name: "recipe.recomputeAllDurable" | "recipe.recomputeStaleDurable",
  select: (costing: Costing) => Promise<RecipeId[]>,
  enqueue: (
    costing: Costing,
    ids: RecipeId[],
  ) => Promise<RecipeCostingCoordinatorResult>,
) =>
  defineCoordinatorStream({
    name,
    select: workflow<Costing, undefined>(`${name}.select`)
      .call("recipeIds", async ({ context }) => select(context))
      .output(({ recipeIds }) => recipeIds),
    commit: workflow<Costing, RecipeCostingCoordinatorInput>(`${name}.enqueue`)
      .commit("queued", async ({ context }, { input: { selection } }) =>
        enqueue(context, selection),
      )
      .output(({ queued }) => queued),
    total: (ids) => ids.length,
  });

const recomputeAllDurableDefinition = recipeCostingCoordinator(
  "recipe.recomputeAllDurable",
  (costing) => costing.selectAllQueued(),
  (costing, ids) => costing.enqueueAllQueued(ids),
);
const recomputeStaleDurableDefinition = recipeCostingCoordinator(
  "recipe.recomputeStaleDurable",
  (costing) => costing.selectStaleQueued(),
  (costing, ids) => costing.enqueueStaleQueued(ids),
);

export const recomputeAllDurableWorkflow = bindCoordinatorStream(
  recomputeAllDurableDefinition,
  (costing: Costing, signal?: AbortSignal) => ({
    context: costing,
    input: undefined,
    signal,
  }),
);
export const recomputeStaleDurableWorkflow = bindCoordinatorStream(
  recomputeStaleDurableDefinition,
  (costing: Costing, signal?: AbortSignal) => ({
    context: costing,
    input: undefined,
    signal,
  }),
);

export const dryRunRecomputeTotalsWorkflow = defineWorkflowOperation(
  "recipe.dryRunRecomputeTotals",
  async (
    costing: AuthenticatedStartOperationContext["services"]["recipeCosting"],
  ) => costing.dryRunRecomputeTotals(),
);

export const explainCostingWorkflow = bindWorkflow(
  workflow<{ db: Database; costing: Costing }, typeof recipeIdInput._output>(
    "recipe.explainCosting",
  )
    .call("id", async ({ context }, { input }) =>
      recipeShortcodes.one(context.db, input.id),
    )
    .call("explanation", async ({ context }, { id }) =>
      context.costing.explainRecipe(id),
    )
    .output(({ explanation }) => explanation),
  (db: Database, input: typeof recipeIdInput._output, costing: Costing) => ({
    context: { db, costing },
    input,
  }),
);
export const getFlowWorkflow = bindWorkflow(
  workflow<Database, typeof recipeFlowGetInputSchema._output>("recipe.getFlow")
    .call("id", async ({ context }, { input }) =>
      recipeShortcodes.one(context, input.id),
    )
    .call("flow", async ({ context }, { id }) =>
      getRecipeFlowState(context, id),
    )
    .output(({ flow }) => flow),
  (db: Database, input: typeof recipeFlowGetInputSchema._output) => ({
    context: db,
    input,
  }),
);
type GenerateFlowContext = { db: Database; runId: RunId };
export const generateFlowWorkflow = bindWorkflow(
  workflow<GenerateFlowContext, typeof recipeFlowGenerateInputSchema._output>(
    "recipe.generateFlow",
  )
    .call("id", async ({ context }, { input }) =>
      recipeShortcodes.one(context.db, input.id),
    )
    .commit("flow", async ({ context }, { input, id }) =>
      generateRecipeFlow(context.db, { ...input, id }, context.runId),
    )
    .output(({ flow }) => flow),
  (
    context: GenerateFlowContext,
    input: typeof recipeFlowGenerateInputSchema._output,
  ) => ({ context, input }),
);

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

const compareEquivalences = (
  candidates: ReturnType<typeof harvestEquivalences>,
  ingredients: Awaited<ReturnType<typeof getIngredientsByIDs>>,
): EquivalenceReport => {
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
        // SILENT: no conversion path between the two units is expected for a
        // genuinely novel equivalence; `existing` stays null and the
        // `existing == null` branch below already treats that as visible.
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

type EquivalenceContext = {
  db: Database;
  usdaClient: Parameters<typeof getIngredientsByIDs>[1];
};
export const harvestEquivalencesWorkflow = bindWorkflow(
  workflow<EquivalenceContext, void>("recipe.harvestEquivalences")
    .call("rows", async ({ context }) =>
      getMultiMeasureRecipeIngredients(context.db),
    )
    .call("candidates", async (_, { rows }) =>
      harvestEquivalences(rows, {
        kindOf: (amount) => wasm.amount_kind(amount),
        convert: convertWithinKind,
      }),
    )
    .branch("report", {
      when: async (_, { candidates }) => candidates.length > 0,
      whenTrue: (branch) =>
        branch
          .call("ingredients", async ({ context }, { input: { candidates } }) =>
            getIngredientsByIDs(
              context.db,
              context.usdaClient,
              uniq(candidates.map((candidate) => candidate.ingredientEntityId)),
            ),
          )
          .output(({ input: { candidates }, ingredients }) =>
            compareEquivalences(candidates, ingredients),
          ),
      whenFalse: (branch) =>
        branch.output((): EquivalenceReport => ({
          candidates: [],
          hiddenCovered: 0,
        })),
    })
    .output(({ report }) => report),
  (db: Database, usdaClient: EquivalenceContext["usdaClient"]) => ({
    context: { db, usdaClient },
    input: undefined,
  }),
);

export const getRecipeAvailabilityWorkflow = defineWorkflowOperation(
  "suggestions.getRecipeAvailability",
  async (
    recipeId: z.output<typeof recipeAvailabilityInput>["recipeId"],
    availability: Pick<
      AuthenticatedStartOperationContext["services"]["availability"],
      "getRecipeAvailability"
    >,
  ) => availability.getRecipeAvailability(recipeId),
);

type MakeableAvailability = Pick<
  AuthenticatedStartOperationContext["services"]["availability"],
  "getRecipeAvailability"
>;
export const getMakeableWorkflow = bindWorkflow(
  workflow<
    { db: Database; availability: MakeableAvailability },
    typeof makeableRecipesInput._output
  >("suggestions.getMakeable")
    .call("candidates", async ({ context }) =>
      recipeList(
        context.db,
        { excludeSubRecipes: true },
        [{ orderBy: "name", direction: "asc" }],
        { pageIndex: 0, pageSize: CANDIDATE_CAP },
      ),
    )
    .map("availabilities", {
      items: ({ candidates }) => candidates.data,
      concurrency: 8,
      run: async ({ context }, { item }) =>
        context.availability.getRecipeAvailability(item.id),
    })
    .output(({ input, candidates, availabilities }) => ({
      recipes: availabilities
        .filter(
          (availability) => availability.coverage >= (input.minCoverage ?? 0),
        )
        .sort((a, b) => b.coverage - a.coverage)
        .slice(0, input.limit ?? 24),
      truncated: candidates.count > CANDIDATE_CAP,
      candidateCap: CANDIDATE_CAP,
    })),
  (
    db: Database,
    input: typeof makeableRecipesInput._output,
    availability: MakeableAvailability,
  ) => ({ context: { db, availability }, input }),
);
