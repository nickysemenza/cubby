/**
 * Recipe-totals recompute offloaded to a Cloudflare Queue.
 *
 * A widely-used ingredient merge (or product/ingredient edit) can touch 100+
 * recipes; recomputing them inline overruns the Workers per-invocation CPU/memory
 * budget and kills the request. Instead the mutation marks the affected recipes
 * stale and *dispatches* their ids here: in production each chunk becomes a queue
 * message drained by its own fresh invocation (its own CPU budget); on the dev
 * Node server (no binding) the caller recomputes inline, which is safe there.
 *
 * The producer binding (`RECOMPUTE_QUEUE`) and the consumer types are kept
 * minimal and self-contained — the repo has no `@cloudflare/workers-types`, so we
 * don't lean on ambient `Queue`/`MessageBatch` globals.
 */

import type { RecipeId } from "@cubby/schemas/identifiers";

/** One queue message: a bounded chunk of recipe ids to recompute. */
export interface RecomputeMessage {
  recipeIds: RecipeId[];
}

/**
 * Chunk size when fanning recipe ids into messages. One message ≈ one
 * `recomputeTree` unit — matches the 25-recipe batch the full backfill
 * (`recomputeAll`) already uses to bound a single transaction's work.
 */
export const RECOMPUTE_CHUNK_SIZE = 25;

/**
 * At or below this many recipes, `dispatchRecompute` recomputes inline (instant
 * totals, no budget risk) rather than queuing. Above it, the set is large enough
 * to threaten the per-invocation budget, so it goes to the queue. The common
 * single-entity edit (one recipe, or an ingredient used by a handful) stays
 * instant; only a popular-ingredient edit / bulk import defers.
 */
export const RECOMPUTE_INLINE_MAX = 5;

/** The producer side of `env.RECOMPUTE_QUEUE` (the subset we call). */
export interface RecomputeQueueProducer {
  send(body: RecomputeMessage): Promise<void>;
}

/** A single delivered message with its ack/retry controls. */
export interface RecomputeQueueMessage {
  readonly body: RecomputeMessage;
  ack(): void;
  retry(): void;
}

/** The batch handed to the Worker's `queue()` consumer. */
export interface RecomputeQueueBatch {
  readonly messages: readonly RecomputeQueueMessage[];
}

/**
 * Consumer entry: recompute the recipes named in a message. Builds services on
 * the current per-request db (the caller must already be inside `withRequestDb`)
 * and runs the same recursive `recompute` the inline path uses, so cost/calorie
 * cascades to parent recipes identically. Imports are dynamic to keep the queue
 * path out of the fetch cold-start bundle.
 */
export async function recomputeRecipeIds(recipeIds: RecipeId[]): Promise<void> {
  if (recipeIds.length === 0) return;
  const { db } = await import("./db");
  const { buildCrudServices } = await import("./api/trpc");
  const { services } = buildCrudServices(db);
  await services.recipeCosting.recompute(recipeIds);
}
