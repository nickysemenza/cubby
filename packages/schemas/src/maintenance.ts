import { z } from "zod";
import { backgroundTaskReceiptSchema } from "./background-tasks";

/**
 * Derived work that is waiting on a queue message that may never arrive.
 *
 * Every count here is read from the source rows' own staleness markers, so the
 * numbers are live truth rather than a job ledger's opinion: a recipe with
 * `totalsComputedAt IS NULL`, a search document whose embedding hash differs
 * from its stored vector (or has none), an upload still PENDING after a day.
 * Publication after commit is best-effort by design; this is the visible
 * backstop, and "Settle now" republishes exactly what the counts describe.
 */
export const awaitingWorkSchema = z.object({
  staleRecipeTotals: z.number().int().nonnegative(),
  unembeddedEntities: z.number().int().nonnegative(),
  pendingUploads: z.number().int().nonnegative(),
  computedAt: z.iso.datetime(),
});
export type AwaitingWork = z.infer<typeof awaitingWorkSchema>;

export const settleAwaitingWorkOutSchema = z.object({
  publishedRecipeTasks: z.number().int().nonnegative(),
  publishedEmbeddingTasks: z.number().int().nonnegative(),
  culledUploads: z.number().int().nonnegative(),
  transport: backgroundTaskReceiptSchema.shape.transport,
});
export type SettleAwaitingWorkOut = z.infer<typeof settleAwaitingWorkOutSchema>;

/**
 * Counters for one search-index repair run. These describe what that run
 * found and did — findings and outcomes — not a live assertion that the index
 * is healthy now. `published` is embedding work handed to the queue, which
 * finishes on its own.
 */
export const searchIndexRepairCountersSchema = z.object({
  scanned: z.number().int().nonnegative(),
  orphaned: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  retired: z.number().int().nonnegative(),
  rebuilt: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
});
export type SearchIndexRepairCounters = z.infer<
  typeof searchIndexRepairCountersSchema
>;

export const searchIndexRepairPhases = ["orphans", "sources"] as const;

/**
 * Progress in the shared bulk-stream shape (`done`/`total`) so the existing
 * streaming button renders it. The total is not known up front — the scan is
 * keyset-paged — so `total` is what has been scanned plus one more page while
 * a cursor remains; it converges on `done` at the end.
 */
export const searchIndexRepairEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    phase: z.enum(searchIndexRepairPhases),
    counters: searchIndexRepairCountersSchema,
  }),
  z.object({
    type: z.literal("done"),
    result: searchIndexRepairCountersSchema,
  }),
]);
export type SearchIndexRepairEvent = z.infer<
  typeof searchIndexRepairEventSchema
>;
