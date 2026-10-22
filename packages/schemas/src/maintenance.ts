import { z } from "zod";
import { runShortcode } from "./identifier-fields";
import { runStatus, runTrigger } from "./run-fields";
import { runStepState } from "./run-step";
import { searchableEntitySchema } from "./search";

/** `maintenance.run`: the pass it started, or the one already active. */
export const maintenanceRunOutSchema = z.object({
  runId: runShortcode,
  existing: z.boolean(),
});
export type MaintenanceRunOut = z.infer<typeof maintenanceRunOutSchema>;

const count = z.number().int().nonnegative();

export const maintenanceRunSummarySchema = z.object({
  runId: runShortcode,
  status: runStatus,
  trigger: runTrigger,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /** The Run's raw failure text: failed step labels or its Workflow error. */
  failure: z.string().nullable(),
  steps: count,
  failedSteps: count,
  /** The first unfinished step, 1-based; null once every step ended. */
  current: z
    .object({
      position: z.number().int().positive(),
      label: z.string(),
      state: runStepState,
      found: count,
      done: count,
      failed: count,
      skipped: count,
      /** Null for a step without a frozen count, which shows no bar. */
      left: count.nullable(),
      pausedReason: z.string().nullable(),
      pausedUntil: z.iso.datetime().nullable(),
    })
    .nullable(),
});
export type MaintenanceRunSummary = z.infer<typeof maintenanceRunSummarySchema>;

export const imageProcessingMaintenanceCounts = z.object({
  current: count,
  pending: count,
  waiting: count,
  skipped: count,
  failed: count,
  reviewNeeded: count,
  remaining: count,
});
export const imageProcessingMaintenanceOutput = z.object({
  description: imageProcessingMaintenanceCounts,
  cutout: imageProcessingMaintenanceCounts,
});

/**
 * The active (or most recent) maintenance pass and the backlogs it drains,
 * each read from the source rows' own staleness markers.
 */
export const maintenanceStatusSchema = z.object({
  active: maintenanceRunSummarySchema.nullable(),
  last: maintenanceRunSummarySchema.nullable(),
  backlog: z.object({
    staleImageMetadata: count,
    originalsMissing: count,
    metadataExtractionFailed: count,
    staleRecipeTotals: count,
    unembeddedEntities: count,
    pendingUploads: count,
    imageProcessing: imageProcessingMaintenanceOutput,
  }),
  computedAt: z.iso.datetime(),
});
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>;

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
 * One-off repair for live images that never received a SearchDocument (the
 * upload paths did not project on create), which the maintenance embeddings step cannot
 * see because it starts from existing documents. Each page is projected and
 * its embeddings queued in bounded batches.
 */
export const backfillImageSearchInputSchema = z.object({
  batchSize: z.number().int().positive().max(200).default(100),
  maxBatches: z.number().int().positive().max(100).default(20),
});
export const backfillImageSearchOutSchema = z.object({
  batches: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  stopped: z.enum(["complete", "limit"]),
});
export type BackfillImageSearchInput = z.infer<
  typeof backfillImageSearchInputSchema
>;
export type BackfillImageSearchOut = z.infer<
  typeof backfillImageSearchOutSchema
>;

/** Classify weak image-source provenance. Manual and capture evidence is protected. */
export const classifyImageProvenanceInputSchema = z.object({
  dryRun: z.boolean().default(false),
  batchSize: z.number().int().positive().max(100).default(25),
  maxBatches: z.number().int().positive().max(100).default(20),
  afterId: z.string().uuid().optional(),
});
export const classifyImageProvenanceOutSchema = z.object({
  dryRun: z.boolean(),
  batches: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  classified: z.number().int().nonnegative(),
  capturedAtSeeded: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  nextCursor: z.string().uuid().nullable(),
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

/** A committed page's resume point; selection, mutation and publication stay together. */
export const searchRepairCheckpoint = z.object({
  phase: z.enum(searchIndexRepairPhases),
  cursor: z
    .object({ entityKind: searchableEntitySchema, entityId: z.string() })
    .nullable(),
  counters: searchIndexRepairCountersSchema,
});
export type SearchRepairCheckpoint = z.infer<typeof searchRepairCheckpoint>;
export const searchRepairContinuation = z.object({
  nextInstanceId: z.string().min(1),
});
export type SearchRepairContinuation = z.infer<typeof searchRepairContinuation>;

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
