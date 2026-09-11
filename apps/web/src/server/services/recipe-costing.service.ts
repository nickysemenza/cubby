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

import type { BackgroundBatchRef } from "@cubby/schemas/background-jobs";
import type { EntityRef } from "@cubby/schemas/entity";
import {
  type IngredientId,
  parseEntityId,
  type RecipeId,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";
import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import {
  hasKnownEstimate,
  type MeasureEstimate,
  nutrientKey,
} from "@cubby/schemas/nutrition";
import type { RecipeGraphOut } from "@cubby/schemas/recipe";
import type {
  RecipeCostingExplain,
  RecipeTotals,
} from "@cubby/schemas/recipe-shared";
import { TIER1_NUTRIENT_KEYS } from "@cubby/usda-schemas";
import { keyBy, uniq } from "es-toolkit";
import { z } from "zod";

import {
  type CalculateTotalsResult,
  type CostingRow,
  computeRecipeCosting,
  flattenSections,
  type RecipeCostingInput,
} from "~/lib/recipe-costing";
import {
  collectIngredientIds,
  getRecipeIngredientName,
} from "~/lib/recipe-graph";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { RECOMPUTE_CHUNK_SIZE } from "~/server/queue-recompute";
import {
  getRecipesByIDs,
  getSubRecipeClosure,
} from "~/server/repo/recipe/crud";
import {
  findParentRecipeIdsBatch,
  findRecipeIdsUsingIngredients,
  getRecipeTotalsState,
  markRecipesStale,
  markRecipesStaleReturningTransitioned,
  markRecipeTotalsFresh,
  selectAllActiveRecipeIds,
  selectAllStaleRecipeIds,
  selectStaleRecipeIds,
  updateRecipeTotalsBatch,
} from "~/server/repo/recipe/totals";
import {
  resolveAllPresent,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
import { TraceNames, withTrace } from "~/server/tracing";

import { getIngredientsByIDs } from "./ingredient.service";
import type { UsdaFoodBatchPort } from "./usda-helpers";

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
  return "reason" in a && "reason" in b && a.reason !== b.reason;
};

const totalsDiffer = (
  a: RecipeTotals | null | undefined,
  b: RecipeTotals,
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

type CascadeMode = "inline" | "queue";
interface RecipeRecomputeDispatchMetadata {
  source?: string;
  entity?: EntityRef;
}

const batchLog = (batchId?: string): string =>
  batchId ? ` batch=${batchId}` : "";

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
    private usdaClient: UsdaFoodBatchPort,
  ) {}

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
          await this.enqueueTargetedChunks(staleRecipeIds, batchId);
          return 0;
        }
        const visited = new Set<RecipeId>();
        const before = visited.size;
        await this.recomputeTree(staleRecipeIds, visited, "queue", batchId);
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
  ): Promise<void> {
    const todo = recipeIds.filter((id) => !visited.has(id));
    if (todo.length === 0) return;
    for (const id of todo) visited.add(id);

    const tLoad = performance.now();
    const recipes = await getRecipesByIDs(this.db, todo);
    const totalsMap = await this.computeTotals(recipes);
    const resolvedRecipeIds = await resolveLiveShortcodes(
      this.db,
      recipes.map((r) => r.id),
      "recipe",
    );
    const loadMs = Math.round(performance.now() - tLoad);
    const updates: Array<{ id: RecipeId; totals: RecipeTotals }> = [];
    const freshOnlyIds: RecipeId[] = [];
    const changedIds: RecipeId[] = [];
    for (const r of recipes) {
      const computed = totalsMap.get(r.id);
      if (!computed) continue;
      const { totals: next } = computed;
      const idValue = resolvedRecipeIds.get(r.id);
      if (!idValue) continue;
      const id = parseEntityId("recipe", idValue);
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
        await this.enqueueParentCascade(parentIds, batchId);
      } else {
        await this.recomputeTree(parentIds, visited, cascadeMode);
      }
    }
  }

  private async enqueueParentCascade(
    parentIds: RecipeId[],
    batchId?: string,
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
    const batch = await this.enqueueTargetedChunks(transitioned, batchId);
    console.log(
      `[recompute-timing] queued${batchLog(batch.id)} ${transitioned.length} changed parent recipe(s) for follow-up recompute`,
    );
  }

  private async enqueueTargetedChunks(
    recipeIds: RecipeId[],
    batchId?: string,
    metadata: RecipeRecomputeDispatchMetadata = {},
  ): Promise<BackgroundBatchRef> {
    const jobs = [];
    for (let i = 0; i < recipeIds.length; i += RECOMPUTE_CHUNK_SIZE) {
      const chunkIds = recipeIds.slice(i, i + RECOMPUTE_CHUNK_SIZE);
      jobs.push({
        kind: "recipe-totals.recompute" as const,
        dedupeKey: `recipe-totals.recompute:${chunkIds.join(",")}`,
        payload: { recipeIds: chunkIds },
      });
    }
    const dispatched = await dispatchBackgroundJobs(this.db, {
      kind: "recipe-totals.recompute",
      source: "mutation",
      batchId,
      metadata: {
        source: metadata.source ?? "recipe-costing.dispatch",
        recipeCount: recipeIds.length,
        ...metadata,
      },
      jobs,
    });
    console.log(
      `[recompute-queue] enqueued targeted chunks batch=${dispatched.batchId} recipes=${recipeIds.length} chunks=${jobs.length}`,
    );
    return dispatched.batch;
  }

  async recomputeForIngredient(
    ingredientId: IngredientId,
    metadata: RecipeRecomputeDispatchMetadata = {
      entity: { entityType: "ingredient", entityId: ingredientId },
    },
  ): Promise<BackgroundBatchRef[]> {
    return this.recomputeForIngredients([ingredientId], metadata);
  }

  async recomputeForIngredients(
    ingredientIds: IngredientId[],
    metadata: RecipeRecomputeDispatchMetadata = {},
  ): Promise<BackgroundBatchRef[]> {
    if (ingredientIds.length === 0) return [];
    const uniqueIngredientIds = uniq(ingredientIds);
    return await withTrace(
      TraceNames.service("recipeCosting", "dispatchForIngredient"),
      async (span) => {
        const recipeIds = uniq(
          await findRecipeIdsUsingIngredients(this.db, uniqueIngredientIds),
        );
        span.setAttributes({
          "ingredient.count": uniqueIngredientIds.length,
          "recipe.dispatched": recipeIds.length,
        });
        return await this.dispatchRecompute(recipeIds, metadata);
      },
    );
  }

  /**
   * The single entry for recompute triggered by a request-path mutation. Every
   * dispatch first marks the affected recipes stale, then persists bounded
   * background jobs for operations visibility. In production, the queue binding
   * drains each chunk in its own invocation with a fresh CPU/memory budget. On
   * the dev Node server (no binding), the same DB jobs process inline, so local
   * behavior is synchronous but still inspectable. Returns the count dispatched.
   */
  async dispatchRecompute(
    recipeIds: RecipeId[],
    metadata: RecipeRecomputeDispatchMetadata = {},
  ): Promise<BackgroundBatchRef[]> {
    const ids = uniq(recipeIds);
    if (ids.length === 0) return [];
    // Correctness floor for both inline and deferred paths: callers may have
    // already committed the triggering write, so stamp stale before any work
    // that can fail independently.
    await markRecipesStale(this.db, ids);
    const batch = await this.enqueueTargetedChunks(ids, undefined, metadata);
    console.log(
      `[recompute-dispatch] batch=${batch.id} affected=${ids.length} chunk_size=${RECOMPUTE_CHUNK_SIZE} mode=targeted`,
    );
    return [batch];
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

  /**
   * DURABLE recompute-all: mark every active recipe stale and enqueue bounded
   * `recipe-totals.recompute` jobs onto the background-jobs queue, returning the
   * batch id — instead of holding a single request open to do the full CPU-heavy
   * pass inline on the request thread. The work then survives a navigate-
   * away / PWA background / Worker CPU limit: it runs on the queue (or inline in
   * dev, where there's no binding), and its progress is inspectable on
   * `/background-jobs`. This is the same queue + dispatch path every mutation-
   * triggered recompute already uses ({@link dispatchRecompute}); a full recompute
   * is just the widest possible affected set.
   */
  async selectAllQueued(): Promise<RecipeId[]> {
    return selectAllActiveRecipeIds(this.db);
  }

  async enqueueAllQueued(ids: RecipeId[]) {
    const total = ids.length;
    if (total === 0) return { enqueued: 0, total: 0, batchId: null };
    const [batch] = await this.dispatchRecompute(ids, {
      source: "maintenance.recompute-all",
    });
    return { enqueued: total, total, batchId: batch?.id ?? null };
  }

  /**
   * DURABLE recompute-STALE: same queue-backed shape as the all-recipes drain,
   * but seeded from {@link selectAllStaleRecipeIds} instead of every active recipe,
   * and calling {@link enqueueTargetedChunks} directly instead of
   * {@link dispatchRecompute}. `dispatchRecompute` starts by marking its ids stale
   * ({@link markRecipesStale}) — a no-op here since these ids are already stale by
   * construction (that's the selection predicate), but a wasted extra `UPDATE` and,
   * more importantly, the wrong doc: `dispatchRecompute` is the "something changed,
   * invalidate + enqueue" entry point, and calling it would misrepresent this as a
   * fresh invalidation instead of a drain of an already-known backlog. So this
   * enqueues the targeted chunks straight from the stale-id selection.
   */
  async selectStaleQueued(): Promise<RecipeId[]> {
    return selectAllStaleRecipeIds(this.db);
  }

  async enqueueStaleQueued(ids: RecipeId[]) {
    const total = ids.length;
    if (total === 0) return { enqueued: 0, total: 0, batchId: null };
    const batch = await this.enqueueTargetedChunks(ids, undefined, {
      source: "maintenance.recompute-stale",
    });
    return { enqueued: total, total, batchId: batch.id };
  }
}
