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
import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import type { RecipeGraphOut } from "@cubby/schemas/recipe";
import type {
  RecipeCostingExplain,
  RecipeMacroColumn,
  RecipeTotals,
} from "@cubby/schemas/recipe-shared";
import {
  RECIPE_MACRO_KEYS,
  recipeTotalsFieldNames,
} from "@cubby/schemas/recipe-shared";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { chunk, keyBy, uniq } from "es-toolkit";
import {
  type CalculateTotalsResult,
  type CostingRow,
  computeRecipeCosting,
  flattenSections,
  type RecipeCostingInput,
} from "~/lib/recipe-costing";
import {
  collectIngredientIds,
  collectSubRecipeIds,
  getRecipeIngredientName,
} from "~/lib/recipe-graph";
import { getRecomputeQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  RECOMPUTE_CHUNK_SIZE,
  RECOMPUTE_INLINE_MAX,
  RECOMPUTE_MESSAGE_VERSION,
  type RecomputeMessage,
} from "~/server/queue-recompute";
import { getRecipesByIDs } from "~/server/repo/recipe/crud";
import {
  findParentRecipeIdsBatch,
  findRecipeIdsUsingIngredient,
  getRecipeTotalsState,
  markRecipesStale,
  markRecipesStaleReturningTransitioned,
  markRecipeTotalsFresh,
  selectAllActiveRecipeIds,
  selectStaleRecipeIds,
  updateRecipeTotalsBatch,
} from "~/server/repo/recipe/totals";
import { TraceNames, withTrace } from "~/server/tracing";
import type { IngredientService } from "./ingredient.service";

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
// change" predicate behind the dry-run. The field roster is owned by the schema
// package so adding a recipeTotals field keeps this comparison exhaustive.
const totalsDiffer = (
  a: RecipeTotals | null | undefined,
  b: RecipeTotals,
): boolean => {
  if (!a) return true;
  return recipeTotalsFieldNames.some((k) => fieldDiffers(a, b, k));
};

type CascadeMode = "inline" | "queue";

const newRecomputeBatchId = (): string => crypto.randomUUID();

const batchLog = (batchId?: string): string =>
  batchId ? ` batch=${batchId}` : "";

/**
 * Products with a confirmed USDA match (`fdc_id`) whose food failed to resolve —
 * a transient backend miss, not real no-data. Doubles as the completeness
 * predicate (empty ⇒ complete) and the named list the explain payload surfaces.
 */
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
  private async loadContext(recipes: RecipeCostingInput[]): Promise<{
    ingMap: Record<string, IngredientWithFoodLeanOut>;
    recipeMap: Record<string, RecipeGraphOut>;
  }> {
    return withTrace(
      TraceNames.service("recipeCosting", "loadContext"),
      async (span) => {
        const recipeMap: Record<string, RecipeGraphOut> = {};
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
    recipes: RecipeCostingInput[],
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
    recipes: RecipeCostingInput[],
  ): Promise<Map<RecipeId, { totals: RecipeTotals; complete: boolean }>> {
    const { ingMap, recipeMap } = await this.loadContext(recipes);

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
      await this.recomputeTree(recipeIds, visited, "inline");
      return visited.size;
    });
  }

  /**
   * Queue-consumer entry. Recompute only this bounded chunk in the current
   * invocation; changed parents are marked stale and re-enqueued as follow-up
   * chunks. That keeps the per-message CPU/wall budget real even when a sub-recipe
   * cascade is deep or when a parent also has a large ingredient closure. Recipe
   * dependency cycles are invalid data, so cross-message cycle state is not part
   * of the queue contract; stale filtering handles duplicate/old messages.
   */
  async recomputeQueued(
    recipeIds: RecipeId[],
    batchId?: string,
    startedAtMs?: number,
  ): Promise<number> {
    return this.tracedRecompute(
      "recompute",
      { "recipe.cascade_mode": "queue", "recipe.batch_id": batchId },
      async () => {
        const staleRecipeIds = await selectStaleRecipeIds(this.db, recipeIds);
        if (staleRecipeIds.length === 0) {
          // A wakeup for recipes another invocation already recomputed — the
          // dedup makes this rare now, so it's worth a line when it happens.
          console.log(
            `[recompute-queue] skipped${batchLog(batchId)} ${recipeIds.length} queued recipe(s): no stale work`,
          );
          return 0;
        }
        // Defensive per-invocation budget guard, not the hot path: every message
        // is produced by enqueueTargetedChunks (≤ RECOMPUTE_CHUNK_SIZE ids), so
        // this is unreachable today. It stays as the backstop that enforces the
        // per-invocation bound by code rather than by producer discipline — if a
        // future/oversized/replayed message ever carries more, re-split instead of
        // overrunning the CPU/mem budget (the original bug class).
        if (staleRecipeIds.length > RECOMPUTE_CHUNK_SIZE) {
          await this.enqueueTargetedChunks(
            staleRecipeIds,
            batchId,
            startedAtMs,
          );
          return 0;
        }
        const visited = new Set<RecipeId>();
        const before = visited.size;
        await this.recomputeTree(
          staleRecipeIds,
          visited,
          "queue",
          batchId,
          startedAtMs,
        );
        return visited.size - before;
      },
    );
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
    cascadeMode: CascadeMode = "inline",
    batchId?: string,
    startedAtMs?: number,
  ): Promise<void> {
    const todo = recipeIds.filter((id) => !visited.has(id));
    if (todo.length === 0) return;
    for (const id of todo) visited.add(id);

    const tLoad = performance.now();
    const recipes = await getRecipesByIDs(this.db, todo);
    const totalsMap = await this.computeTotals(recipes);
    const loadMs = Math.round(performance.now() - tLoad);
    const updates: Array<{ id: RecipeId; totals: RecipeTotals }> = [];
    const freshOnlyIds: RecipeId[] = [];
    const changedIds: RecipeId[] = [];
    for (const r of recipes) {
      const computed = totalsMap.get(r.id as RecipeId);
      if (!computed) continue;
      const { totals: next } = computed;
      const id = r.id as RecipeId;
      if (totalsDiffer(r.totals, next)) {
        updates.push({ id, totals: next });
        changedIds.push(id);
      } else {
        freshOnlyIds.push(id);
      }
    }
    const tWrite = performance.now();
    await updateRecipeTotalsBatch(this.db, updates);
    await markRecipeTotalsFresh(this.db, freshOnlyIds);
    const writeMs = Math.round(performance.now() - tWrite);
    // One line per processed chunk. `load+compute` is real wall-clock (it spans
    // DB reads + the USDA fetch, which are I/O so the workerd clock advances);
    // WASM CPU is invisible here by design (see computeTotalsInner). The batch
    // total + per-message duration come from cf-server's `message ack` line.
    console.log(
      `[recompute] recipes=${todo.length} changed=${changedIds.length} fresh=${freshOnlyIds.length} load+compute=${loadMs}ms write=${writeMs}ms`,
    );
    // One batched lookup for every changed recipe's parents (was an N+1 — a query
    // per changed recipe). Parent cascades are driven by actual total changes, not
    // merely by a stale child being restamped fresh; otherwise repeated queue
    // messages keep re-staling parents and create their own backlog.
    const parentsByRecipe = await findParentRecipeIdsBatch(this.db, changedIds);
    const changedParents = new Set<RecipeId>();
    for (const parents of parentsByRecipe.values())
      for (const p of parents) changedParents.add(p);
    const parentIds = [...changedParents].filter((id) => !visited.has(id));
    if (parentIds.length > 0) {
      if (cascadeMode === "queue") {
        await this.enqueueParentCascade(parentIds, batchId, startedAtMs);
      } else {
        await this.recomputeTree(parentIds, visited, cascadeMode);
      }
    }
  }

  private async enqueueParentCascade(
    parentIds: RecipeId[],
    batchId?: string,
    startedAtMs?: number,
  ): Promise<void> {
    // Only enqueue parents that actually transitioned fresh→stale. A parent
    // already stale (in the initial dispatch set, or staled by a sibling chunk)
    // is already queued — re-staling + re-sending it just produces no-op
    // `stale=0` wakeups and churns the table. This collapses the fan-out to one
    // enqueue per parent per stale episode.
    const transitioned = await markRecipesStaleReturningTransitioned(
      this.db,
      parentIds,
    );
    if (transitioned.length === 0) return;
    await this.enqueueTargetedChunks(transitioned, batchId, startedAtMs);
    console.log(
      `[recompute-timing] queued${batchLog(batchId)} ${transitioned.length} changed parent recipe(s) for follow-up recompute`,
    );
  }

  private async enqueueTargetedChunks(
    recipeIds: RecipeId[],
    batchId = newRecomputeBatchId(),
    startedAtMs = Date.now(),
  ): Promise<void> {
    const queue = getRecomputeQueue();
    if (!queue) {
      await this.recomputeTree(recipeIds, new Set(), "inline");
      return;
    }
    const messages: RecomputeMessage[] = [];
    for (let i = 0; i < recipeIds.length; i += RECOMPUTE_CHUNK_SIZE) {
      messages.push({
        messageVersion: RECOMPUTE_MESSAGE_VERSION,
        recipeIds: recipeIds.slice(i, i + RECOMPUTE_CHUNK_SIZE),
        batchId,
        startedAtMs,
      });
    }
    // One sendBatch round-trip per ≤100 messages instead of N serial sends — the
    // dispatch runs in the request path, so this shortens product.update and lands
    // the whole wave in the queue at once. (CF caps a sendBatch at 100 / 256KB.)
    for (const group of chunk(messages, 100)) {
      await queue.sendBatch(group.map((body) => ({ body })));
    }
    console.log(
      `[recompute-queue] enqueued targeted chunks batch=${batchId} recipes=${recipeIds.length} chunks=${messages.length}`,
    );
  }

  /**
   * Recompute every recipe whose cost depends on an ingredient — its product's
   * price/USDA-link changed, the ingredient was edited, or a merge repointed rows
   * onto it. Routes through {@link dispatchRecompute}, so a handful of affected
   * recipes recompute inline (instant) while a popular ingredient's large set
   * defers to the queue. Returns the count recomputed (inline) or queued.
   */
  async recomputeForIngredient(ingredientId: IngredientId): Promise<number> {
    return this.recomputeForIngredients([ingredientId]);
  }

  /**
   * Batched {@link recomputeForIngredient}: dedupe the affected recipes across
   * many ingredients (e.g. a bulk product-create) so recipes shared by several
   * are dispatched once.
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
        return await this.dispatchRecompute(recipeIds);
      },
    );
  }

  /**
   * The single entry for recompute triggered by a request-path mutation. A small
   * set ({@link RECOMPUTE_INLINE_MAX} or fewer) recomputes inline — instant
   * totals, no budget risk. Every dispatch first marks the affected recipes
   * stale; a failed inline recompute therefore leaves a visible maintenance gap
   * instead of a fresh-looking wrong total. A larger set, in production (the
   * `RECOMPUTE_QUEUE` binding present), is fanned into bounded chunks (one
   * message each), so each chunk drains in its own invocation with a fresh
   * CPU/memory budget. On the dev Node server (no binding) everything recomputes
   * inline. Returns the count recomputed (inline) or queued.
   */
  async dispatchRecompute(recipeIds: RecipeId[]): Promise<number> {
    const ids = uniq(recipeIds);
    if (ids.length === 0) return 0;
    // Correctness floor for both inline and deferred paths: callers may have
    // already committed the triggering write, so stamp stale before any work
    // that can fail independently.
    await markRecipesStale(this.db, ids);
    const queue = getRecomputeQueue();
    if (!queue || ids.length <= RECOMPUTE_INLINE_MAX) {
      return await this.recompute(ids);
    }
    const startedAtMs = Date.now();
    const batchId = newRecomputeBatchId();
    await this.enqueueTargetedChunks(ids, batchId, startedAtMs);
    console.log(
      `[recompute-dispatch] batch=${batchId} affected=${ids.length} chunk_size=${RECOMPUTE_CHUNK_SIZE} mode=targeted`,
    );
    return ids.length;
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

  /**
   * Streaming variant of {@link recomputeAll} for the on-demand maintenance
   * button: same chunked work (each chunk's `recomputeTree` commits
   * independently), but `yield`s `{done,total}` per chunk so the UI can show a
   * live bar. No trace span (the non-streaming method keeps that for MCP).
   */
  async *recomputeAllStream(): AsyncGenerator<
    { done: number; total: number },
    { processed: number }
  > {
    const ids = await selectAllActiveRecipeIds(this.db);
    const CHUNK = 25;
    const total = ids.length;
    let done = 0;
    yield { done, total };
    for (let i = 0; i < ids.length; i += CHUNK) {
      await this.recomputeTree(ids.slice(i, i + CHUNK));
      done = Math.min(i + CHUNK, total);
      yield { done, total };
    }
    return { processed: total };
  }
}
