import type {
  CandidateEquivalence,
  EquivalenceReport,
} from "@cubby/schemas/equivalences";
import type { RecipeId } from "@cubby/schemas/identifiers";
import { EMPTY_MUTATION_SIDE_EFFECTS } from "@cubby/schemas/mutation-side-effects";
import type {
  recipeCookbookScopeInput,
  recipeIdInput,
} from "@cubby/schemas/recipe";
import type { makeableRecipesInput } from "@cubby/schemas/suggestions";
import { uniq } from "es-toolkit";

import {
  recipeContract,
  recipeStreamsContract,
  suggestionsContract,
} from "~/contracts/recipe.contract";
import { harvestEquivalences } from "~/lib/harvest-equivalences";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { Database } from "~/server/db";
import { implementOperationDomain } from "~/server/operation-domain.server";
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
import { aiCallRunInput, ensureRun } from "~/server/runs/ensure-run";
import { getIngredientsByIDs } from "~/server/services/ingredient.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import {
  generateRecipeFlow,
  getRecipeFlowState,
} from "~/server/services/recipe-flow/recipe-flow.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { implementSubscriptionDomain } from "~/server/subscription-domain.server";
import {
  bindWorkflow,
  bindCoordinatorStream,
  defineCoordinatorStream,
  workflow,
} from "~/server/workflow-runtime";

import * as imports from "./recipe-import.server";

const recipeShortcodes = bindShortcodeResolver("recipe");
const cookbookShortcodes = bindShortcodeResolver("cookbook");
const CANDIDATE_CAP = 500;

async function getManyRecipesByIDs(
  db: Database,
  input: { ids: Parameters<typeof recipeShortcodes.all>[1] },
) {
  return getRecipesByIDs(db, await recipeShortcodes.all(db, input.ids));
}

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
        entity: { entityKind: "recipe", entityId },
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
);

const cookbookScoped =
  <Output>(
    read: (
      db: Database,
      id: Parameters<typeof getRecipeDependencyGraph>[1],
    ) => Promise<Output>,
  ) =>
  async (
    db: Database,
    input: typeof recipeCookbookScopeInput._output,
  ): Promise<Output> =>
    read(
      db,
      input?.cookbookId
        ? await cookbookShortcodes.one(db, input.cookbookId)
        : undefined,
    );

type Costing = AuthenticatedStartOperationContext["services"]["recipeCosting"];
async function recomputeOne(
  db: Database,
  input: typeof recipeIdInput._output,
  costing: Costing,
) {
  const processed = await costing.recompute([
    await recipeShortcodes.one(db, input.id),
  ]);
  return { processed };
}

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

async function harvestEquivalencesReport(
  db: Database,
  usdaClient: Parameters<typeof getIngredientsByIDs>[1],
): Promise<EquivalenceReport> {
  const rows = await getMultiMeasureRecipeIngredients(db);
  const candidates = harvestEquivalences(rows, {
    kindOf: (amount) => wasm.amount_kind(amount),
    convert: convertWithinKind,
  });
  if (candidates.length === 0) return { candidates: [], hiddenCovered: 0 };
  const ingredients = await getIngredientsByIDs(
    db,
    usdaClient,
    uniq(candidates.map((candidate) => candidate.ingredientEntityId)),
  );
  return compareEquivalences(candidates, ingredients);
}

type MakeableAvailability = Pick<
  AuthenticatedStartOperationContext["services"]["availability"],
  "getRecipeAvailability"
>;
const makeableWorkflow = bindWorkflow(
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
);
export const getMakeableWorkflow = (
  db: Database,
  input: typeof makeableRecipesInput._output,
  availability: MakeableAvailability,
) => makeableWorkflow({ db, availability }, input);

export async function explainCostingWorkflow(
  db: Database,
  input: typeof recipeIdInput._output,
  costing: Costing,
) {
  return costing.explainRecipe(await recipeShortcodes.one(db, input.id));
}

export const recipeHandlers = implementOperationDomain(recipeContract, {
  getManyByIDs: (context, input) => getManyRecipesByIDs(context.db, input),
  duplicate: (context, input) => duplicateWorkflow(context, input),
  getIngredientCooccurrence: (context, input) =>
    getIngredientCooccurrence(context.db, input?.minEdgeWeight ?? 2),
  getDependencyGraph: (context, input) =>
    cookbookScoped(getRecipeDependencyGraph)(context.db, input),
  getIngredientUsage: (context, input) =>
    cookbookScoped(getIngredientUsage)(context.db, input),
  recomputeOne: (context, input) =>
    recomputeOne(context.db, input, context.services.recipeCosting),
  dryRunRecomputeTotals: (context) =>
    context.services.recipeCosting.dryRunRecomputeTotals(),
  explainCosting: (context, input) =>
    explainCostingWorkflow(context.db, input, context.services.recipeCosting),
  getFlow: async (context, input) =>
    getRecipeFlowState(
      context.db,
      await recipeShortcodes.one(context.db, input.id),
    ),
  generateFlow: async (context, input) => {
    const runId = await ensureRun(
      context.db,
      context.actorContext,
      aiCallRunInput(context.actorContext),
    );
    return generateRecipeFlow(
      context.db,
      { ...input, id: await recipeShortcodes.one(context.db, input.id) },
      runId,
    );
  },
  harvestEquivalences: (context) =>
    harvestEquivalencesReport(context.db, context.usdaClient),
  scrape: (_context, input) => imports.scrapeWorkflow(input),
  parseHtml: async (_context, input) => imports.parseHtmlWorkflow(input),
  upsertCookbook: (context, input) =>
    imports.upsertCookbookWorkflow(context, input),
  getCookbookSource: (context, input) =>
    imports.getCookbookSourceWorkflow(context, input),
  getCookbookDiff: (context, input) =>
    imports.getCookbookDiffWorkflow(context, input),
  previewNotionSync: (context) => imports.previewNotionSyncWorkflow(context),
  setCookbookProduct: (context, input) =>
    imports.setCookbookProductWorkflow(context, input),
  deleteCookbook: (context, input) =>
    imports.deleteCookbookWorkflow(context, input),
  forwardGatewayRequest: (context, input) =>
    imports.forwardGatewayRequestWorkflow(context, input),
  attachCookbookRecipePhoto: (context, input) =>
    imports.attachCookbookRecipePhotoWorkflow(context, input),
});

export const suggestionsHandlers = implementOperationDomain(
  suggestionsContract,
  {
    getRecipeAvailability: (context, input) =>
      context.services.availability.getRecipeAvailability(input.recipeId),
    getMakeable: (context, input) =>
      getMakeableWorkflow(context.db, input, context.services.availability),
  },
);

export const recipeStreamHandlers = implementSubscriptionDomain(
  recipeStreamsContract,
  {
    recomputeAllDurable: (context, _input, signal) =>
      recomputeAllDurableWorkflow(context.services.recipeCosting, signal),
    recomputeStaleDurable: (context, _input, signal) =>
      recomputeStaleDurableWorkflow(context.services.recipeCosting, signal),
    importCookbookStream: (context, input, signal) =>
      imports.importCookbookWorkflow(context, input, signal),
    importNotionSyncStream: (context, input, signal) =>
      imports.importNotionSyncWorkflow(context, input, signal),
    reprocessCookbook: (context, input, signal) =>
      imports.reprocessCookbookWorkflow(context, input, signal),
  },
);
