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

export const repairImageDimensionsInputSchema = z.object({
  batchSize: z.number().int().positive().max(100).default(25),
  maxBatches: z.number().int().positive().max(100).default(20),
});
export const repairImageDimensionsOutSchema = z.object({
  batches: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  repaired: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  stopped: z.enum(["complete", "limit", "no_progress"]),
});
export type RepairImageDimensionsInput = z.infer<
  typeof repairImageDimensionsInputSchema
>;
export type RepairImageDimensionsOut = z.infer<
  typeof repairImageDimensionsOutSchema
>;

/**
 * Filename/dimension heuristics + on-device analysis `capturedAt` seeding for
 * images still `source = unknown` or last classified by a filename rule
 * (`image-provenance-heuristics.ts`). `dryRun` runs the same selection and
 * classification and reports what WOULD change, writing nothing.
 */
export const classifyImageProvenanceInputSchema = z.object({
  dryRun: z.boolean().default(false),
  batchSize: z.number().int().positive().max(100).default(25),
  maxBatches: z.number().int().positive().max(100).default(20),
});
export const classifyImageProvenanceOutSchema = z.object({
  dryRun: z.boolean(),
  batches: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  classified: z.number().int().nonnegative(),
  capturedAtSeeded: z.number().int().nonnegative(),
  // Per filename-rule-id match counts (`filenameProvenanceRuleIds`), e.g.
  // `{ "legacy-uploader-photo-jpeg": 3, "catalog-source-asset-url": 12 }`.
  byRule: z.record(z.string(), z.number().int().nonnegative()),
  remaining: z.number().int().nonnegative(),
  stopped: z.enum(["complete", "limit", "no_progress"]),
});
export type ClassifyImageProvenanceInput = z.infer<
  typeof classifyImageProvenanceInputSchema
>;
export type ClassifyImageProvenanceOut = z.infer<
  typeof classifyImageProvenanceOutSchema
>;

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

export const imageProcessingSettings = z.object({
  enabled: z.boolean(),
  paused: z.boolean(),
});
export const imageProcessingMaintenanceCounts = z.object({
  current: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reviewNeeded: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
});
export const imageProcessingMaintenanceOutput = z.object({
  settings: imageProcessingSettings,
  description: imageProcessingMaintenanceCounts,
  cutout: imageProcessingMaintenanceCounts,
});
export const imageProcessingBatchInput = z.object({
  batchSize: z.number().int().min(1).max(100).default(25),
  retryFailures: z.boolean().default(false),
});
export const imageProcessingBatchOutput = z.object({
  submissionId: z.string().nullable().optional(),
  scheduled: z.number().int().nonnegative(),
  paused: z.boolean(),
});
