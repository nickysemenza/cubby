/**
 * Server-side recipe cost/calorie rollup. Computes the same totals the client
 * used to (reusing `calculateTotals` + the ingredient USDA enrichment) and
 * persists them on `Recipe.totals`, so the list reads them directly instead of
 * fetching every ingredient and running WASM per page load.
 *
 * Freshness is event-driven: writes null `totalsComputedAt` on the affected rows
 * (see repo/recipe/totals + the recipe/product write paths); this service's
 * `drainStale` recomputes them, driven by the client while the app is open.
 */

import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type {
  RecipeCostingExplain,
  RecipeMacroColumn,
  RecipeOut,
  RecipeTotals,
} from "@cubby/schemas/recipe";
import { RECIPE_MACRO_KEYS, recipeTotals } from "@cubby/schemas/recipe";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { keyBy, uniq } from "es-toolkit";
import {
  type CalculateTotalsResult,
  type CostingRow,
  computeRecipeCosting,
  flattenSections,
} from "~/lib/recipe-costing";
import {
  collectIngredientIds,
  collectSubRecipeIds,
  getRecipeIngredientName,
} from "~/lib/recipe-graph";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { getRecipesByIDs } from "~/server/repo/recipe/crud";
import {
  findParentRecipeIds,
  findRecipeIdsUsingIngredient,
  getRecipeTotalsState,
  selectAllActiveRecipeIds,
  updateRecipeTotals,
} from "~/server/repo/recipe/totals";
import { TraceNames, withTrace } from "~/server/tracing";
import type {
  IngredientService,
  IngredientWithFoodOut,
} from "./ingredient.service";

const toRecipeTotals = (t: CalculateTotalsResult): RecipeTotals => {
  // Upper bounds only when the recipe has ranged amounts (additive — absent
  // means "no range", so the headline renders one number).
  const caloriesUpper = t.nutrientsUpper
    ? getNutrientValueByKey(t.nutrientsUpper, "kcal")
    : undefined;
  return {
    costTotal: t.price,
    ...(t.priceUpper != null ? { costTotalUpper: t.priceUpper } : {}),
    caloriesTotal: getNutrientValueByKey(t.nutrients, "kcal") ?? 0,
    ...(caloriesUpper != null ? { caloriesTotalUpper: caloriesUpper } : {}),
    // Whole-recipe macros — already computed by the engine, carried through from
    // the single RECIPE_MACRO_KEYS roster (no per-macro list to drift from read).
    ...RECIPE_MACRO_KEYS.reduce<Pick<RecipeTotals, RecipeMacroColumn>>(
      (acc, key) => {
        acc[`${key}Total`] = getNutrientValueByKey(t.nutrients, key);
        return acc;
      },
      {},
    ),
    ingredientCount: t.totalIngredients,
    costCovered: t.totalIngredients - t.missingByType.price.length,
    caloriesCovered: t.totalIngredients - t.missingByType.nutrients.length,
  };
};

// Per-field tolerance for "persisted differs from a fresh compute". Cost is
// near-exact (only float-summation noise), but calories are integer-rounded
// downstream, so a looser 0.5 avoids flagging rounding-only churn. Everything
// else defaults to a small epsilon. One map so the dry-run predicate
// (totalsDiffer) and explainRecipe's drift can't diverge.
const DEFAULT_EPSILON = 0.005;
const TOTALS_EPSILON: Partial<Record<keyof RecipeTotals, number>> = {
  caloriesTotal: 0.5,
};

/** Whether one RecipeTotals field differs beyond its tolerance. */
const fieldDiffers = (
  a: RecipeTotals,
  b: RecipeTotals,
  field: keyof RecipeTotals,
): boolean =>
  Math.abs((a[field] ?? 0) - (b[field] ?? 0)) >
  (TOTALS_EPSILON[field] ?? DEFAULT_EPSILON);

// Whether a fresh compute differs from what's persisted — the honest "would
// change" predicate behind the dry-run (catches logic-change drift the stale
// flag misses). Every recipeTotals field is numeric, so we compare them all
// (derived from the schema, so new fields are covered automatically) via the
// shared per-field tolerance. Null persisted ⇒ new.
const TOTALS_FIELDS = Object.keys(recipeTotals.shape) as (keyof RecipeTotals)[];

const totalsDiffer = (
  a: RecipeTotals | null | undefined,
  b: RecipeTotals,
): boolean => {
  if (!a) return true;
  return TOTALS_FIELDS.some((k) => fieldDiffers(a, b, k));
};

/**
 * Products with a confirmed USDA match (`fdc_id`) whose food failed to resolve —
 * a transient backend miss, not real no-data. Doubles as the completeness
 * predicate (empty ⇒ complete) and the named list the explain payload surfaces.
 */
const usdaMissesFor = (
  rows: CostingRow[],
  ingMap: Record<string, IngredientWithFoodOut>,
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
      if (p.fdc_id != null && p.food == null) {
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
    private ingredientService: IngredientService,
  ) {}

  /**
   * Load everything a costing pass needs for these recipes: the transitive
   * closure of sub-recipes (recipe-as-ingredient, cycle-guarded) and the
   * USDA-enriched ingredient map.
   */
  private async loadContext(recipes: RecipeOut[]): Promise<{
    ingMap: Record<string, IngredientWithFoodOut>;
    recipeMap: Record<string, RecipeOut>;
  }> {
    return withTrace(
      TraceNames.service("recipeCosting", "loadContext"),
      async (span) => {
        const recipeMap: Record<string, RecipeOut> = {};
        const seen = new Set<string>();
        let frontier = collectSubRecipeIds(recipes);
        while (frontier.length > 0) {
          const toFetch = frontier.filter((id) => !seen.has(id));
          for (const id of toFetch) seen.add(id);
          if (toFetch.length === 0) break;
          const fetched = await getRecipesByIDs(this.db, toFetch);
          frontier = [];
          for (const r of fetched) {
            recipeMap[r.id] = r;
            frontier.push(...collectSubRecipeIds([r]));
          }
        }

        const ingredientIds = collectIngredientIds([
          ...recipes,
          ...Object.values(recipeMap),
        ]);
        span.setAttribute(
          "recipe.subrecipe_count",
          Object.keys(recipeMap).length,
        );
        span.setAttribute("ingredient.count", ingredientIds.length);
        const ingredients =
          await this.ingredientService.getIngredientsByIDs(ingredientIds);
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
    recipes: RecipeOut[],
  ): Promise<Map<RecipeId, { totals: RecipeTotals; complete: boolean }>> {
    return withTrace(
      TraceNames.service("recipeCosting", "computeTotals"),
      async (span) => {
        span.setAttribute("recipe.count", recipes.length);
        return this.computeTotalsInner(recipes);
      },
    );
  }

  private async computeTotalsInner(
    recipes: RecipeOut[],
  ): Promise<Map<RecipeId, { totals: RecipeTotals; complete: boolean }>> {
    const { ingMap, recipeMap } = await this.loadContext(recipes);

    // One engine call for the whole batch (ingredients serialized once). Traced
    // separately so WASM engine time is visible apart from DB/USDA IO.
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
      RecipeId,
      { totals: RecipeTotals; complete: boolean }
    >();
    for (const r of recipes) {
      const costing = costings.get(r.id);
      if (!costing) continue;
      result.set(r.id as RecipeId, {
        complete:
          usdaMissesFor(flattenSections(r.sections), ingMap).length === 0,
        totals: toRecipeTotals(costing.totals),
      });
    }
    return result;
  }

  /**
   * Full costing explanation for one recipe: the persisted state (totals,
   * computed-at, staleness), a fresh compute with per-row diagnostics enriched
   * with unit-graph conversion paths, named USDA misses, and persisted-vs-live
   * drift. Read-only — never stamps or recomputes persisted state.
   */
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
        fieldDiffers(persisted, computedTotals, "costTotal"),
      calories:
        persisted != null &&
        fieldDiffers(persisted, computedTotals, "caloriesTotal"),
    };

    return {
      persisted: {
        totals: state.totals,
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

  /**
   * Wrap a recompute bulk operation in the canonical span + log so every
   * recompute entry point reports its duration the same way: a
   * `service.recipeCosting.{operation}` span carrying `recipe.recomputed` +
   * `duration_ms` (and any extra attrs), plus a `[recipe-totals]` console line
   * for `wrangler tail`. Owns the format so it can't drift per call site.
   */
  private async tracedRecompute(
    operation: string,
    extraAttrs: Record<string, string | number | boolean | undefined>,
    run: () => Promise<number>,
  ): Promise<number> {
    return withTrace(
      TraceNames.service("recipeCosting", operation),
      async (span) => {
        const t0 = performance.now();
        const recomputed = await run();
        const ms = Math.round(performance.now() - t0);
        span.setAttributes({
          ...extraAttrs,
          "recipe.recomputed": recomputed,
          duration_ms: ms,
        });
        console.log(
          `[recipe-totals] ${operation} recomputed ${recomputed} recipe(s) in ${ms}ms`,
        );
        return recomputed;
      },
    );
  }

  /**
   * Public, timed entry for recomputing a known set of recipes (recipe
   * create/update/import/reprocess). Wraps the recursive {@link recomputeTree}
   * with one span + log. Returns the count of recipes recomputed (the set plus
   * any cascaded parents).
   */
  async recompute(recipeIds: RecipeId[]): Promise<number> {
    return this.tracedRecompute("recompute", {}, async () => {
      const visited = new Set<RecipeId>();
      await this.recomputeTree(recipeIds, visited);
      return visited.size;
    });
  }

  /**
   * Recompute + persist totals for the given recipe ids, then **eagerly recurse
   * into any parent recipes whose sub-recipe cost changed** so the whole tree is
   * fresh in one pass (a recipe is an ingredient when used as a sub-recipe). USDA
   * is always available now, so a recompute either succeeds or throws — we always
   * stamp fresh; a `usdaMiss` is a permanent costing gap, not a stale-for-retry
   * state. `visited` guards against re-work and sub-recipe cycles.
   *
   * Internal/recursive worker — **always call this from inside the service**
   * (recursion, the ingredient/all funnels), never the timed public
   * {@link recompute}, so a single bulk op emits exactly one span + log line.
   */
  private async recomputeTree(
    recipeIds: RecipeId[],
    visited: Set<RecipeId> = new Set(),
  ): Promise<void> {
    const todo = recipeIds.filter((id) => !visited.has(id));
    if (todo.length === 0) return;
    for (const id of todo) visited.add(id);

    const recipes = await getRecipesByIDs(this.db, todo);
    const totalsMap = await this.computeTotals(recipes);
    const changedParents = new Set<RecipeId>();
    for (const r of recipes) {
      const computed = totalsMap.get(r.id as RecipeId);
      if (!computed) continue;
      const { totals: next } = computed;
      // Always stamp fresh — USDA is reliable, so an unresolved fdc_id is a
      // permanent gap (surfaced by the coverage UI), not a transient miss.
      await updateRecipeTotals(this.db, r.id as RecipeId, next);
      const changed =
        !r.totals ||
        r.totals.costTotal !== next.costTotal ||
        r.totals.caloriesTotal !== next.caloriesTotal;
      if (changed) {
        for (const p of await findParentRecipeIds(this.db, r.id as RecipeId))
          changedParents.add(p);
      }
    }
    // Recurse into changed parents (visited prevents re-work / cycles).
    if (changedParents.size > 0) {
      await this.recomputeTree([...changedParents], visited);
    }
  }

  /**
   * Eagerly recompute every recipe whose cost depends on an ingredient — its
   * product's price/USDA-link changed, the ingredient was edited, or a merge
   * repointed rows onto it. Returns the total number of recipes recomputed
   * (direct users + cascaded parents) for the mutation's side-effects summary.
   */
  async recomputeForIngredient(ingredientId: IngredientId): Promise<number> {
    return this.recomputeForIngredients([ingredientId]);
  }

  /**
   * Batched {@link recomputeForIngredient}: dedupe the affected recipes across
   * many ingredients (e.g. a bulk product-create) and recompute the union once,
   * so recipes shared by several created products aren't recomputed N times.
   */
  async recomputeForIngredients(
    ingredientIds: IngredientId[],
  ): Promise<number> {
    if (ingredientIds.length === 0) return 0;
    const uniqueIngredientIds = uniq(ingredientIds);
    return this.tracedRecompute(
      "recomputeForIngredient",
      { "ingredient.count": uniqueIngredientIds.length },
      async () => {
        const recipeIds = uniq(
          (
            await Promise.all(
              uniqueIngredientIds.map((id) =>
                findRecipeIdsUsingIngredient(this.db, id),
              ),
            )
          ).flat(),
        );
        const visited = new Set<RecipeId>();
        await this.recomputeTree(recipeIds, visited);
        return visited.size;
      },
    );
  }

  /**
   * Dry run: compute every recipe's totals in memory and count how many would
   * actually change vs what's persisted — without writing. ~As costly as
   * recomputeAll (full engine pass, no DB write), so call it on demand only.
   */
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
                const computed = totalsMap.get(r.id as RecipeId);
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

  /**
   * Recompute every recipe's totals regardless of stale state. One-shot backfill
   * / admin recovery (e.g. after the USDA backend was unavailable during a drain).
   * Chunked so a large library doesn't hold one giant transaction.
   */
  async recomputeAll(): Promise<{ processed: number }> {
    const processed = await this.tracedRecompute(
      "recomputeAll",
      {},
      async () => {
        const ids = await selectAllActiveRecipeIds(this.db);
        const CHUNK = 25;
        for (let i = 0; i < ids.length; i += CHUNK) {
          await this.recomputeTree(ids.slice(i, i + CHUNK));
        }
        return ids.length;
      },
    );
    return { processed };
  }
}
