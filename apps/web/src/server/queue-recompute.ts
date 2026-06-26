/**
 * Recipe-totals recompute offloaded to a Cloudflare Queue.
 *
 * A widely-used ingredient merge (or product/ingredient edit) can touch 100+
 * recipes; recomputing them inline overruns the Workers per-invocation CPU/memory
 * budget and kills the request. Instead the mutation marks the affected recipes
 * stale and dispatches bounded targeted recipe-id messages. The consumer filters
 * each message against the current DB stale set, so old messages for already-fresh
 * recipes become cheap no-ops. On the dev Node server (no binding) the caller
 * recomputes inline, which is safe there.
 *
 * The producer binding (`RECOMPUTE_QUEUE`) and the consumer types are kept
 * minimal and self-contained — the repo has no `@cloudflare/workers-types`, so we
 * don't lean on ambient `Queue`/`MessageBatch` globals.
 */

import type { RecipeId } from "@cubby/schemas/identifiers";

export const RECOMPUTE_MESSAGE_VERSION = 1;

/**
 * One queue message: a bounded targeted chunk of recipe ids to recompute.
 */
export interface RecomputeMessage {
  messageVersion: number;
  recipeIds: RecipeId[];
  /** Correlates all targeted chunks and parent-cascade messages from one wave. */
  batchId?: string;
  /**
   * Wall-clock (`Date.now()`) when the wave was dispatched, copied verbatim onto
   * every chunk + cascade follow-up. A batch spans many separate queue
   * invocations, so there's no one process to time it end-to-end; each message
   * instead logs `batch_elapsed_ms = Date.now() - startedAtMs`, and the largest
   * value across the batch's log lines is the total drain time.
   */
  startedAtMs?: number;
}

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
  /**
   * One round-trip for a whole wave of chunks (vs N serial `send`s in the
   * request path). CF caps a batch at 100 messages / 256KB; callers chunk above
   * that.
   */
  sendBatch(messages: Iterable<{ body: RecomputeMessage }>): Promise<void>;
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
 * Consumer entry. Builds services on the current per-request db (the caller must
 * already be inside `withRequestDb`). Imports are dynamic to keep the queue path
 * out of the fetch cold-start bundle.
 */
export async function recomputeRecipeIds({
  recipeIds = [],
  batchId,
  startedAtMs,
}: Partial<RecomputeMessage>): Promise<void> {
  if (recipeIds.length === 0) return;
  const { db } = await import("./db");
  const { buildCrudServices } = await import("./api/trpc");
  const { services } = buildCrudServices(db);
  await services.recipeCosting.recomputeQueued(recipeIds, batchId, startedAtMs);
}
