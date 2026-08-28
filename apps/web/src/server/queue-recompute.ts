/**
 * Recipe-totals recompute handler for background jobs.
 *
 * A widely-used ingredient merge (or product/ingredient edit) can touch 100+
 * recipes; recomputing them inline overruns the Workers per-invocation CPU/memory
 * budget and kills the request. Instead the mutation marks the affected recipes
 * stale and dispatches bounded targeted recipe-id jobs. The consumer filters
 * each job against the current DB stale set, so old jobs for already-fresh
 * recipes become cheap no-ops. On the dev Node server (no binding) the same
 * persisted jobs process inline, which keeps the operations UI honest without
 * requiring Cloudflare Queues locally.
 *
 * The Cloudflare Queue envelope is generic and lives in `background-queue.ts`.
 * This module only exposes the recipe-specific processing entry point.
 */

import type { RecipeId } from "@cubby/schemas/identifiers";

import type { Database } from "./db";

/**
 * Number of target recipe ids per queue message. The bound is now wall-time /
 * USDA-batch size, not CPU: the WASM costing engine is ~0ms per chunk and
 * cpu_ms is 45000, so 25 keeps each handler comfortably bounded while halving
 * the message count (fewer USDA refetches + queue sends) vs the old 10. Raising
 * this is safe; it only changes granularity, not correctness (stale-filter +
 * cascade dedup are size-independent).
 */
export const RECOMPUTE_CHUNK_SIZE = 25;

/**
 * Consumer entry. Builds services on the current per-request db (the caller must
 * already be inside `withRequestDb`). Imports are dynamic to keep the queue path
 * out of the fetch cold-start bundle.
 */
export async function recomputeRecipeIds({
  database,
  recipeIds = [],
  batchId,
}: {
  database: Database;
  recipeIds?: RecipeId[];
  batchId?: string;
}): Promise<void> {
  if (recipeIds.length === 0) return;
  const { buildCrudServices } = await import("./request-context");
  const { services } = buildCrudServices(database);
  await services.recipeCosting.recomputeQueued(recipeIds, batchId);
}
