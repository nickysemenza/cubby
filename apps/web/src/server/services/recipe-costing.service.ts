/**
 * Server-side recipe cost/calorie rollup. Computes the same totals the client
 * used to (reusing `calculateTotals` + the ingredient USDA enrichment) and
 * persists them on `Recipe.totals`, so the list reads them directly instead of
 * fetching every ingredient and running WASM per page load.
 *
 * Freshness is event-driven: writes null `totalsComputedAt` on the affected
 * rows (see repo/recipe/totals + the recipe/product write paths). The stale
 * flag is the durable record of pending work; a queue task, a read of the
 * recipe page, or "Settle now" recomputes it. Queue messages are wakeups only.
 */

import { RECIPE_RECOMPUTE_CHUNK_SIZE } from "@cubby/schemas/background-tasks";
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
import {
  type BackgroundTaskPublisher,
  publishBackgroundTasks,
} from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  getRecipesByIDs,
  getSubRecipeClosure,
} from "~/server/repo/recipe/crud";
import {
  commitRecipeTotals,
  findRecipeIdsUsingIngredients,
  findStaleParentRecipeIds,
  getRecipeTotalsState,
  markRecipesStale,
  selectAllActiveRecipeIds,
  selectAllStaleRecipeIds,
  selectStaleRecipeIds,
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
    private publish: BackgroundTaskPublisher = publishBackgroundTasks,
  ) {}

  /**
   * The same service on another database handle — a caller's open
   * transaction — with its publications routed through `publish`. Stale marks
   * then land in the caller's transaction (an outer-pool UPDATE on a row that
   * transaction holds would deadlock) and the wakeups go out only after it
   * commits.
   */
  bindTo(db: Database, publish: BackgroundTaskPublisher): RecipeCostingService {
    return new RecipeCostingService(db, this.usdaClient, publish);
  }

  /** The handle this instance reads and writes through — the request's strong pool unless `bindTo` rebound it. */
  get database(): Database {
    return this.db;
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
   * Queue-consumer entry (also run inline by the recipe page's repair-on-read
   * and by "Settle now"). Recompute only this bounded chunk in the current
   * invocation; parents whose totals changed are invalidated in the same
   * transaction as the child's write and published afterwards.
   *
   * Publication is decided by the parents' CURRENT staleness, not by whether
   * this wakeup staled them: an already-fresh child still publishes its stale
   * parents, so a parent whose earlier publication was lost is recovered by
   * any later wakeup of any child. A duplicate wakeup for a fresh child never
   * re-stales a fresh parent — it only re-publishes parents that are stale
   * anyway, which their own freshness gate turns into a no-op.
   */
  async recomputeQueued(recipeIds: RecipeId[]): Promise<number> {
    return this.tracedRecompute(
      "recompute",
      { "recipe.cascade_mode": "queue" },
      async () => {
        const staleRecipeIds = await selectStaleRecipeIds(this.db, recipeIds);
        // Defensive per-invocation budget guard: every message is produced by
        // publishChunks (≤ RECIPE_RECOMPUTE_CHUNK_SIZE ids), so this is
        // unreachable today. It enforces the bound by code rather than by
        // producer discipline — an oversized message is re-split, not run.
        if (staleRecipeIds.length > RECIPE_RECOMPUTE_CHUNK_SIZE) {
          await this.publishChunks(staleRecipeIds, "recipe-costing.resplit");
          return 0;
        }
        const visited = new Set<RecipeId>();
        if (staleRecipeIds.length > 0) {
          await this.recomputeTree(staleRecipeIds, visited, "queue");
        }
        const staleParents = await findStaleParentRecipeIds(this.db, recipeIds);
        if (staleParents.length > 0) {
          await this.publishChunks(
            staleParents,
            "recipe-costing.parent-cascade",
          );
          console.log(
            `[recompute-queue] published ${staleParents.length} stale parent recipe(s) for follow-up recompute`,
          );
        }
        return visited.size;
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
    // Totals, fresh stamps, and the invalidation of changed parents commit
    // together. Parent cascades are driven by actual total changes, not merely
    // by a stale child being restamped fresh; otherwise repeated wakeups would
    // keep re-staling parents and create their own backlog.
    const { changedParentIds } = await commitRecipeTotals(this.db, {
      updates,
      freshOnlyIds,
      changedIds,
      processedIds: todo,
    });
    const writeMs = Math.round(performance.now() - tWrite);
    // One line per processed chunk. `load+compute` is real wall-clock (it spans
    // DB reads + the USDA fetch, which are I/O so the workerd clock advances);
    // WASM CPU is invisible here by design (see computeTotalsInner).
    console.log(
      `[recompute] recipes=${todo.length} changed=${changedIds.length} fresh=${freshOnlyIds.length} load+compute=${loadMs}ms write=${writeMs}ms`,
    );
    // Queue mode stops here: the parents are durably stale, and the caller
    // publishes every currently-stale parent after this chunk commits.
    if (cascadeMode === "queue") return;
    const parentIds = changedParentIds.filter((id) => !visited.has(id));
    if (parentIds.length > 0) {
      await this.recomputeTree(parentIds, visited, cascadeMode);
    }
  }

  /** Publish bounded recompute tasks for a set of already-stale recipes. */
  private async publishChunks(
    recipeIds: RecipeId[],
    source: string,
  ): Promise<void> {
    const requestedAt = new Date().toISOString();
    const tasks = [];
    for (let i = 0; i < recipeIds.length; i += RECIPE_RECOMPUTE_CHUNK_SIZE) {
      tasks.push({
        kind: "recipe-totals.recompute" as const,
        requestedAt,
        recipeIds: recipeIds.slice(i, i + RECIPE_RECOMPUTE_CHUNK_SIZE),
      });
    }
    const receipt = await this.publish(this.db, tasks, { source });
    console.log(
      `[recompute-queue] published recipes=${recipeIds.length} chunks=${tasks.length} transport=${receipt.transport} source=${source}`,
    );
  }

  async recomputeForIngredient(
    ingredientId: IngredientId,
    metadata: RecipeRecomputeDispatchMetadata = {
      entity: { entityType: "ingredient", entityId: ingredientId },
    },
  ): Promise<number> {
    return this.recomputeForIngredients([ingredientId], metadata);
  }

  async recomputeForIngredients(
    ingredientIds: IngredientId[],
    metadata: RecipeRecomputeDispatchMetadata = {},
  ): Promise<number> {
    if (ingredientIds.length === 0) return 0;
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
   * dispatch first marks the affected recipes stale — the durable record — then
   * publishes bounded tasks. In production the queue drains each chunk in its
   * own invocation with a fresh CPU/memory budget; on the dev Node server (no
   * binding) the same handler runs inline. Returns the count of recipes
   * invalidated.
   */
  async dispatchRecompute(
    recipeIds: RecipeId[],
    metadata: RecipeRecomputeDispatchMetadata = {},
  ): Promise<number> {
    const ids = uniq(recipeIds);
    if (ids.length === 0) return 0;
    // Correctness floor for both inline and deferred paths: callers may have
    // already committed the triggering write, so stamp stale before any work
    // that can fail independently.
    await markRecipesStale(this.db, ids);
    await this.publishChunks(ids, metadata.source ?? "recipe-costing.dispatch");
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

  /**
   * Recompute-all: mark every active recipe stale and publish bounded
   * `recipe-totals.recompute` tasks — instead of holding a single request open
   * to do the full CPU-heavy pass inline. The work then survives a navigate-
   * away / PWA background / Worker CPU limit: it runs on the queue (or inline
   * in dev, where there's no binding). This is the same path every
   * mutation-triggered recompute uses ({@link dispatchRecompute}); a full
   * recompute is just the widest possible affected set.
   */
  async selectAllQueued(): Promise<RecipeId[]> {
    return selectAllActiveRecipeIds(this.db);
  }

  async enqueueAllQueued(ids: RecipeId[]) {
    const total = ids.length;
    if (total === 0) return { enqueued: 0, total: 0 };
    await this.dispatchRecompute(ids, { source: "maintenance.recompute-all" });
    return { enqueued: total, total };
  }

  /**
   * Recompute-STALE: same shape as the all-recipes drain, but seeded from
   * {@link selectAllStaleRecipeIds} and publishing straight from that selection
   * rather than through {@link dispatchRecompute}, whose stale-marking would be a
   * no-op here and would misrepresent a backlog drain as a fresh invalidation.
   */
  async selectStaleQueued(): Promise<RecipeId[]> {
    return selectAllStaleRecipeIds(this.db);
  }

  async enqueueStaleQueued(ids: RecipeId[]) {
    const total = ids.length;
    if (total === 0) return { enqueued: 0, total: 0 };
    await this.publishChunks(ids, "maintenance.recompute-stale");
    return { enqueued: total, total };
  }
}
