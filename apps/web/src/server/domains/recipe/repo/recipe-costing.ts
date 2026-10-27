import type { EntityRef } from "@cubby/schemas/entity";
/**
 * Server-side recipe cost/calorie rollup. Computes the same totals the client
 * used to (reusing `calculateTotals` + the ingredient USDA enrichment) and
 * persists them on `Recipe.totals`, so the list reads them directly instead of
 * fetching every ingredient and running WASM per page load.
 *
 * Freshness is event-driven: writes null `totalsComputedAt` on the affected
 * rows (see repo/recipe/totals + the recipe/product write paths). The stale
 * flag describes the persisted projection. A transactional broad Job refreshes
 * it; page reads serve stored totals. Queue messages are wakeups only.
 */
import {
  type IngredientId,
  type RecipeId,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";
import type { RawIngredientWithFoodLean as IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient-raw-read";
import {
  estimateCoverage,
  hasKnownEstimate,
  type MeasureEstimate,
  nutrientKey,
  withMacros,
} from "@cubby/schemas/nutrition";
import type { RawRecipeGraph as RecipeGraphOut } from "@cubby/schemas/recipe-raw-read";
import type {
  RecipeCostingExplain,
  RecipeTotals,
  StoredRecipeTotals,
} from "@cubby/schemas/recipe-shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { TIER1_NUTRIENT_KEYS } from "@cubby/usda";
import { keyBy, uniq } from "es-toolkit";
import { z } from "zod";

import {
  type CalculateTotalsResult,
  type CostingRow,
  computeRecipeCosting,
  flattenSections,
  recipeWasmInput,
  type RecipeCostingInput,
} from "~/lib/recipe-costing";
import {
  collectIngredientIds,
  getRecipeIngredientName,
} from "~/lib/recipe-graph";
import type { Database } from "~/server/db";
import {
  getIngredientsByIDs,
  enrichPreparedIngredients,
} from "~/server/domains/ingredient/repo/ingredient-with-food";
import { getIngredientsByIDsLean } from "~/server/domains/ingredient/repo/search";
import { foodLookupParamFromProduct } from "~/server/domains/product/repo/helpers";
import {
  getRecipesByIDs,
  getSubRecipeClosure,
} from "~/server/domains/recipe/repo/crud";
import {
  getRecipeTotalsState,
  markRecipesStale,
  selectAllActiveRecipeIds,
  selectAllStaleRecipeIds,
} from "~/server/domains/recipe/repo/totals";
import type { UsdaFoodBatchPort } from "~/server/domains/usda-food/repo/usda-helpers";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";
import { resolveAllPresent } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { TraceNames, withTrace } from "~/server/observability/tracing";

const toRecipeTotals = (totals: CalculateTotalsResult): RecipeTotals =>
  totals.estimates;

// A status or coverage change is meaningful even when the known amount stays zero.
const estimateDiffers = (
  a: MeasureEstimate,
  b: MeasureEstimate,
  epsilon = 0.005,
): boolean => {
  if (a.status !== b.status) return true;
  if (hasKnownEstimate(a) && hasKnownEstimate(b)) {
    return (
      Math.abs(a.lower - b.lower) > epsilon ||
      (a.upper == null) !== (b.upper == null) ||
      (a.upper != null &&
        b.upper != null &&
        Math.abs(a.upper - b.upper) > epsilon) ||
      a.coverage.covered !== b.coverage.covered ||
      a.coverage.total !== b.coverage.total
    );
  }
  if ("reason" in a && "reason" in b && a.reason !== b.reason) return true;
  // Unavailable rows can gain or lose contributors without changing reason.
  const aCoverage = estimateCoverage(a);
  const bCoverage = estimateCoverage(b);
  return (
    (aCoverage == null) !== (bCoverage == null) ||
    (aCoverage != null &&
      bCoverage != null &&
      (aCoverage.covered !== bCoverage.covered ||
        aCoverage.total !== bCoverage.total))
  );
};

const totalsDiffer = (
  a: StoredRecipeTotals | null | undefined,
  b: StoredRecipeTotals,
): boolean =>
  !a ||
  estimateDiffers(a.cost, b.cost) ||
  TIER1_NUTRIENT_KEYS.some((key) =>
    estimateDiffers(
      a.nutrition[key],
      b.nutrition[key],
      key === "kcal" ? 0.5 : 0.005,
    ),
  );

interface RecipeRecomputeDispatchMetadata {
  source?: string;
  entity?: EntityRef;
}

// An fdc_id lookup miss is transient, not evidence of absent nutrition data.
const usdaMissesFor = (
  rows: CostingRow[],
  ingMap: Record<string, IngredientWithFoodLeanOut>,
): { ingredientName: string; productName: string; fdcId: number }[] => {
  const misses: {
    ingredientName: string;
    productName: string;
    fdcId: number;
  }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.type !== "ingredient" || seen.has(row.ingredient.id)) continue;
    seen.add(row.ingredient.id);
    const entry = ingMap[row.ingredient.id];
    for (const p of entry?.product ?? []) {
      // A label supersedes the fdc lookup outright, so a labelled product's
      // fdc miss isn't a real gap — it already has nutrition.
      if (p.fdc_id != null && p.food == null && p.labelNutrition == null) {
        misses.push({
          ingredientName: entry?.name ?? row.ingredient.name,
          productName: p.name,
          fdcId: p.fdc_id,
        });
      }
    }
  }
  return misses;
};

export class RecipeCostingService {
  constructor(
    private db: Database,
    private usdaClient: UsdaFoodBatchPort,
  ) {}

  /** Bind stale markers and durable Job admission to the caller's transaction. */
  bindTo(db: Database): RecipeCostingService {
    return new RecipeCostingService(db, this.usdaClient);
  }

  /** The handle this instance reads and writes through — the request's strong pool unless `bindTo` rebound it. */
  get database(): Database {
    return this.db;
  }

  /** Fingerprint authoritative inputs before provider/WASM work can fail. */
  async prepareRefresh(recipeId: RecipeId) {
    const recipes = await getRecipesByIDs(this.db, [recipeId]);
    const recipeMap = await getSubRecipeClosure(this.db, recipes);
    const closure = [...recipes, ...Object.values(recipeMap)];
    const ingredients = await getIngredientsByIDsLean(
      this.db,
      await resolveAllPresent(
        this.db,
        "ingredient",
        collectIngredientIds(closure),
      ),
    );
    const fingerprint = await sha256Hex(
      JSON.stringify([
        "recipe-costing-input-v1",
        closure
          .map((recipe) => recipeWasmInput(recipe, getRecipeIngredientName))
          .sort((a, b) => a.id.localeCompare(b.id)),
        ingredients
          .map((ingredient) => ({
            id: ingredient.id,
            naKinds: ingredient.naKinds,
            products: ingredient.product
              .map((product) => ({
                id: product.id,
                price: product.pricing.effectivePrice,
                unitMappings: product.unitMappings,
                labelNutrition: product.labelNutrition,
                food: foodLookupParamFromProduct(product),
              }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ]),
    );
    return {
      fingerprint,
      compute: async (): Promise<RecipeTotals | null> => {
        const recipe = recipes[0];
        if (!recipe) return null;
        const enriched = await enrichPreparedIngredients(
          this.usdaClient,
          ingredients,
        );
        const computed = await this.computePreparedTotals(recipes, {
          ingMap: keyBy(enriched, (ingredient) => ingredient.id),
          recipeMap,
        });
        return computed.get(recipe.id)?.totals ?? null;
      },
    };
  }

  private async loadContext(recipes: RecipeCostingInput[]): Promise<{
    ingMap: Record<string, IngredientWithFoodLeanOut>;
    recipeMap: Record<string, RecipeGraphOut>;
  }> {
    return withTrace(
      TraceNames.service("recipeCosting", "loadContext"),
      async (span) => {
        const recipeMap = await getSubRecipeClosure(this.db, recipes);

        const ingredientIds = collectIngredientIds([
          ...recipes,
          ...Object.values(recipeMap),
        ]);
        span.setAttribute(
          "recipe.subrecipe_count",
          Object.keys(recipeMap).length,
        );
        span.setAttribute("ingredient.count", ingredientIds.length);
        const ingredients = await getIngredientsByIDs(
          this.db,
          this.usdaClient,
          await resolveAllPresent(this.db, "ingredient", ingredientIds),
        );
        const ingMap = keyBy(ingredients, (i) => i.id);
        return { ingMap, recipeMap };
      },
    );
  }

  /**
   * Compute totals for the given (fully-loaded) recipes. `complete` is false
   * when a USDA lookup that should have resolved (a product with an `fdc_id`)
   * came back null — a transient backend miss the caller should retry rather
   * than bake in.
   */
  async computeTotals(
    recipes: RecipeCostingInput[],
  ): Promise<
    Map<RecipeShortcode, { totals: RecipeTotals; complete: boolean }>
  > {
    return withTrace(
      TraceNames.service("recipeCosting", "computeTotals"),
      async (span) => {
        span.setAttribute("recipe.count", recipes.length);
        return this.computeTotalsInner(recipes);
      },
    );
  }

  private async computeTotalsInner(
    recipes: RecipeCostingInput[],
  ): Promise<
    Map<RecipeShortcode, { totals: RecipeTotals; complete: boolean }>
  > {
    const { ingMap, recipeMap } = await this.loadContext(recipes);
    return this.computePreparedTotals(recipes, { ingMap, recipeMap });
  }

  private async computePreparedTotals(
    recipes: RecipeCostingInput[],
    {
      ingMap,
      recipeMap,
    }: Awaited<ReturnType<RecipeCostingService["loadContext"]>>,
  ): Promise<
    Map<RecipeShortcode, { totals: RecipeTotals; complete: boolean }>
  > {
    // One engine call for the whole batch (ingredients serialized once). Traced
    // separately so WASM engine time is visible apart from DB/USDA IO. NOTE:
    // wall-clock timing of this call is meaningless on workerd — its frozen clock
    // doesn't advance during pure-CPU work, so any `performance.now()` delta reads
    // ~0 and the real CPU lands on the next I/O. Rely on the trace span / CF CPU
    // metric, not a log line.
    const costings = await withTrace(
      TraceNames.wasm("computeRecipeCosting"),
      async () =>
        computeRecipeCosting(
          recipes,
          ingMap,
          getRecipeIngredientName,
          recipeMap,
        ),
    );

    const result = new Map<
      RecipeShortcode,
      { totals: RecipeTotals; complete: boolean }
    >();
    for (const r of recipes) {
      const costing = costings.get(r.id);
      if (!costing) continue;
      result.set(r.id, {
        complete:
          usdaMissesFor(flattenSections(r.sections), ingMap).length === 0,
        totals: toRecipeTotals(costing.totals),
      });
    }
    return result;
  }

  /**
   * One recipe's complete costing with the ingredient context it was computed from. Coverage reads
   * need both: the per-row measures say what could not be resolved, the ingredients say which fix
   * would resolve it.
   */
  async costingWithContext(recipeId: RecipeId) {
    const [recipe] = await getRecipesByIDs(this.db, [recipeId]);
    if (!recipe) throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
    const { ingMap, recipeMap } = await this.loadContext([recipe]);
    const costing = computeRecipeCosting(
      [recipe],
      ingMap,
      getRecipeIngredientName,
      recipeMap,
    ).get(recipe.id);
    if (!costing)
      throw createAppError("RECIPE_NOT_FOUND", "Recipe could not be costed");
    return { costing, ingMap };
  }

  async explainRecipe(recipeId: RecipeId): Promise<RecipeCostingExplain> {
    const [state, recipes] = await Promise.all([
      getRecipeTotalsState(this.db, recipeId),
      getRecipesByIDs(this.db, [recipeId]),
    ]);
    const recipe = recipes[0];
    if (!state || !recipe) {
      throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
    }

    const { ingMap, recipeMap } = await this.loadContext([recipe]);
    const rows = flattenSections(recipe.sections);
    // Explain mode: the engine attaches the unit-graph route per measure to
    // each row's diagnostic — the "show your work" that makes a wrong number
    // self-explanatory — driven by the row's own amount or its estimated grams.
    const costing = computeRecipeCosting(
      [recipe],
      ingMap,
      getRecipeIngredientName,
      recipeMap,
      { explain: true },
    ).get(recipe.id);
    if (!costing) {
      throw createAppError("RECIPE_NOT_FOUND", "Recipe could not be costed");
    }
    const computedTotals = toRecipeTotals(costing.totals);
    const usdaMisses = usdaMissesFor(rows, ingMap);
    const diagnostics = costing.totals.diagnostics;

    const persisted = state.totals;
    const drift = {
      cost:
        persisted != null &&
        estimateDiffers(persisted.cost, computedTotals.cost),
      nutrition: z
        .record(nutrientKey, z.boolean())
        .parse(
          Object.fromEntries(
            TIER1_NUTRIENT_KEYS.map((key) => [
              key,
              persisted != null &&
                estimateDiffers(
                  persisted.nutrition[key],
                  computedTotals.nutrition[key],
                  key === "kcal" ? 0.5 : 0.005,
                ),
            ]),
          ),
        ),
    };

    return {
      persisted: {
        totals: state.totals ? withMacros(state.totals) : null,
        totalsComputedAt: state.totalsComputedAt,
        stale: state.totalsComputedAt == null,
      },
      computed: {
        totals: computedTotals,
        complete: usdaMisses.length === 0,
        diagnostics,
        usdaMisses,
      },
      drift,
    };
  }

  /** Explicit background recompute records the same broad recipes Job. */
  async recompute(recipeIds: RecipeId[]): Promise<number> {
    return this.dispatchRecompute(recipeIds, {
      source: "recipe-costing.explicit",
    });
  }

  async recomputeQueued(recipeIds: RecipeId[]): Promise<number> {
    return this.dispatchRecompute(recipeIds, {
      source: "recipe-costing.explicit",
    });
  }

  async recomputeForIngredient(
    ingredientId: IngredientId,
    metadata: RecipeRecomputeDispatchMetadata = {
      entity: { entityKind: "ingredient", entityId: ingredientId },
    },
  ): Promise<void> {
    return this.recomputeForIngredients([ingredientId], metadata);
  }

  async recomputeForIngredients(
    ingredientIds: IngredientId[],
    metadata: RecipeRecomputeDispatchMetadata = {},
  ): Promise<void> {
    if (ingredientIds.length === 0) return;
    const uniqueIngredientIds = uniq(ingredientIds);
    return await withTrace(
      TraceNames.service("recipeCosting", "dispatchForIngredient"),
      async (span) => {
        span.setAttributes({
          "ingredient.count": uniqueIngredientIds.length,
          "refresh.source": metadata.source ?? "recipe-costing",
        });
        await recordChange(this.db, {
          kind: "source",
          categories: ["ingredient"],
        });
      },
    );
  }

  /** Record stale totals and broad refresh intent in the same transaction. */
  async dispatchRecompute(
    recipeIds: RecipeId[],
    _metadata: RecipeRecomputeDispatchMetadata = {},
  ): Promise<number> {
    const ids = uniq(recipeIds);
    if (ids.length === 0) return 0;
    await markRecipesStale(this.db, ids);
    return ids.length;
  }

  async dryRunRecomputeTotals(): Promise<{
    wouldChange: number;
    total: number;
  }> {
    return withTrace(
      TraceNames.service("recipeCosting", "dryRunRecomputeTotals"),
      async (span) => {
        const ids = await selectAllActiveRecipeIds(this.db);
        const CHUNK = 25;
        const chunkCount = Math.ceil(ids.length / CHUNK);
        span.setAttributes({
          "recipe.total": ids.length,
          "chunk.size": CHUNK,
          "chunk.count": chunkCount,
        });
        let wouldChange = 0;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunkIds = ids.slice(i, i + CHUNK);
          await withTrace(
            TraceNames.service("recipeCosting", "computeTotalsChunk"),
            async (chunkSpan) => {
              chunkSpan.setAttributes({
                "chunk.index": i / CHUNK,
                "chunk.recipe_count": chunkIds.length,
              });
              const recipes = await getRecipesByIDs(this.db, chunkIds);
              const totalsMap = await this.computeTotals(recipes);
              for (const r of recipes) {
                const computed = totalsMap.get(r.id);
                if (computed && totalsDiffer(r.totals, computed.totals))
                  wouldChange++;
              }
            },
          );
        }
        span.setAttribute("recipe.would_change", wouldChange);
        return { wouldChange, total: ids.length };
      },
    );
  }

  /** Explicit full refresh uses the same broad recipes Job as mutation capture. */
  async selectAllQueued(): Promise<RecipeId[]> {
    return selectAllActiveRecipeIds(this.db);
  }

  async enqueueAllQueued(ids: RecipeId[]) {
    const total = ids.length;
    if (total === 0) return { enqueued: 0, total: 0 };
    await this.dispatchRecompute(ids, { source: "maintenance.recompute-all" });
    return { enqueued: total, total };
  }

  /** Select persisted pending totals for an explicit refresh request. */
  async selectStaleQueued(): Promise<RecipeId[]> {
    return selectAllStaleRecipeIds(this.db);
  }

  async enqueueStaleQueued(ids: RecipeId[]) {
    const total = ids.length;
    if (total === 0) return { enqueued: 0, total: 0 };
    await this.dispatchRecompute(ids, {
      source: "maintenance.recompute-stale",
    });
    return { enqueued: total, total };
  }
}
