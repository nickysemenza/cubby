import { z } from "zod";
import { searchableEntities } from "./entity-manifest";

// Keep background-job payload validation independent of search.ts so search
// can reuse the generic batch-reference schema without a runtime import cycle.
const backgroundSearchableEntitySchema = z.enum(searchableEntities);

export const backgroundJobKinds = [
  "recipe-totals.recompute",
  "entity-embedding.refresh",
  "entity-embedding.backfill.coordinator",
  "search-document.repair.coordinator",
  "location-ai.description.refresh",
  "location-ai.inventory.refresh",
  "location-valuation.recompute",
  "problems.counts.refresh",
  "usda-match.retry",
] as const;

export const backgroundJobKindSchema = z.enum(backgroundJobKinds);
export type BackgroundJobKind = z.infer<typeof backgroundJobKindSchema>;

export const backgroundBatchStatuses = [
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
] as const;

export const backgroundBatchStatusSchema = z.enum(backgroundBatchStatuses);
export type BackgroundBatchStatus = z.infer<typeof backgroundBatchStatusSchema>;

export const backgroundJobStatuses = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
] as const;

export const backgroundJobStatusSchema = z.enum(backgroundJobStatuses);
export type BackgroundJobStatus = z.infer<typeof backgroundJobStatusSchema>;

export const backgroundBatchSources = [
  "ui",
  "mutation",
  "backfill",
  "maintenance",
  "queue",
  "dev-inline",
] as const;

export const backgroundBatchSourceSchema = z.enum(backgroundBatchSources);
export type BackgroundBatchSource = z.infer<typeof backgroundBatchSourceSchema>;

export const backgroundBatchProcessors = ["queue", "inline"] as const;

export const backgroundBatchProcessorSchema = z.enum(backgroundBatchProcessors);
export type BackgroundBatchProcessor = z.infer<
  typeof backgroundBatchProcessorSchema
>;

export const recipeTotalsRecomputePayloadSchema = z.object({
  recipeIds: z.array(z.string()).min(1),
});

export const entityEmbeddingRefreshPayloadSchema = z.object({
  entityType: backgroundSearchableEntitySchema,
  entityId: z.string(),
  /**
   * A coordinator records the exact normalized source hash it inspected. The
   * worker checks it before calling the embedding provider, so a concurrent
   * write cannot spend tokens on text that has already changed.
   */
  expectedEmbeddingHash: z.string().optional(),
});

const workflowCursorSchema = z.object({
  entityType: backgroundSearchableEntitySchema,
  entityId: z.string(),
});

/** Coordinator payloads carry their own durable page state for retry safety. */
export const entityEmbeddingBackfillCoordinatorPayloadSchema = z.object({
  source: z.literal("search.debug.semanticBackfill"),
  workflow: z.object({
    type: z.literal("entity-embedding.backfill.coordinator"),
    entityTypes: z.array(backgroundSearchableEntitySchema),
    cursor: workflowCursorSchema.nullable(),
    pagesCompleted: z.number().int().nonnegative(),
    jobsQueued: z.number().int().nonnegative(),
    state: z.enum(["active", "complete"]),
  }),
});
export const searchDocumentRepairCoordinatorPayloadSchema = z.object({
  source: z.literal("search.documentRepair"),
  workflow: z.object({
    type: z.literal("search-document.repair.coordinator"),
    phase: z.enum(["documents", "missing"]),
    cursor: workflowCursorSchema.nullable(),
    scanned: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    retired: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
    orphaned: z.number().int().nonnegative(),
    state: z.enum(["active", "complete"]),
  }),
});

export const locationAiRefreshPayloadSchema = z.object({
  locationId: z.string(),
});

export const locationValuationRecomputePayloadSchema = z.object({
  reason: z.string().optional(),
});

export const problemCountsRefreshPayloadSchema = z.object({
  requestedAt: z.iso.datetime(),
});

// A `suggestUsdaFoodBatch` item that rejected at the infra level (network/AI
// gateway blip) rather than genuinely finding no match — see
// `suggestUsdaFoodBatch`'s `Promise.allSettled` catch. Retried on the queue's
// own backoff instead of being silently indistinguishable from "no match".
export const usdaMatchRetryPayloadSchema = z.object({
  ingredientId: z.string(),
});

export const backgroundJobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recipe-totals.recompute"),
    payload: recipeTotalsRecomputePayloadSchema,
  }),
  z.object({
    kind: z.literal("entity-embedding.refresh"),
    payload: entityEmbeddingRefreshPayloadSchema,
  }),
  z.object({
    kind: z.literal("entity-embedding.backfill.coordinator"),
    payload: entityEmbeddingBackfillCoordinatorPayloadSchema,
  }),
  z.object({
    kind: z.literal("search-document.repair.coordinator"),
    payload: searchDocumentRepairCoordinatorPayloadSchema,
  }),
  z.object({
    kind: z.literal("location-ai.description.refresh"),
    payload: locationAiRefreshPayloadSchema,
  }),
  z.object({
    kind: z.literal("location-ai.inventory.refresh"),
    payload: locationAiRefreshPayloadSchema,
  }),
  z.object({
    kind: z.literal("location-valuation.recompute"),
    payload: locationValuationRecomputePayloadSchema,
  }),
  z.object({
    kind: z.literal("problems.counts.refresh"),
    payload: problemCountsRefreshPayloadSchema,
  }),
  z.object({
    kind: z.literal("usda-match.retry"),
    payload: usdaMatchRetryPayloadSchema,
  }),
]);

export type BackgroundJobPayload = z.infer<typeof backgroundJobPayloadSchema>;

export const enqueueEmbeddingBackfillInputSchema = z.object({
  entityTypes: z.array(backgroundSearchableEntitySchema).optional(),
});

const backgroundBatchSummaryFields = {
  id: z.string(),
  kind: backgroundJobKindSchema,
  source: backgroundBatchSourceSchema,
  processor: backgroundBatchProcessorSchema,
  status: backgroundBatchStatusSchema,
  totalJobs: z.number().int().nonnegative(),
  queuedJobs: z.number().int().nonnegative(),
  runningJobs: z.number().int().nonnegative(),
  succeededJobs: z.number().int().nonnegative(),
  failedJobs: z.number().int().nonnegative(),
  skippedJobs: z.number().int().nonnegative(),
  cancelledJobs: z.number().int().nonnegative(),
  firstEnqueuedAt: z.coerce.date().nullable(),
  lastEnqueuedAt: z.coerce.date().nullable(),
  firstJobStartedAt: z.coerce.date().nullable(),
  lastJobFinishedAt: z.coerce.date().nullable(),
  processingDurationMs: z.number().int().nonnegative().nullable(),
  wallDurationMs: z.number().int().nonnegative().nullable(),
  activeDurationMs: z.number().int().nonnegative(),
  metadata: z.unknown().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
};

export const backgroundBatchRefSchema = z.object({
  id: backgroundBatchSummaryFields.id,
  kind: backgroundBatchSummaryFields.kind,
  source: backgroundBatchSummaryFields.source,
  processor: backgroundBatchSummaryFields.processor,
  status: backgroundBatchSummaryFields.status,
  totalJobs: backgroundBatchSummaryFields.totalJobs,
});

export type BackgroundBatchRef = z.infer<typeof backgroundBatchRefSchema>;

export const enqueueEmbeddingBackfillOutSchema = z.object({
  batch: backgroundBatchRefSchema,
  reused: z.boolean(),
});

export type EnqueueEmbeddingBackfillOut = z.infer<
  typeof enqueueEmbeddingBackfillOutSchema
>;

export const mutationSideEffectsSchema = z.object({
  backgroundBatches: z.array(backgroundBatchRefSchema),
});

export type MutationSideEffects = z.infer<typeof mutationSideEffectsSchema>;

export const backgroundBatchSummarySchema = z.object(
  backgroundBatchSummaryFields,
);

export type BackgroundBatchSummary = z.infer<
  typeof backgroundBatchSummarySchema
>;

export const backgroundJobSummarySchema = z.object({
  id: z.string(),
  batchId: z.string(),
  kind: backgroundJobKindSchema,
  dedupeKey: z.string(),
  status: backgroundJobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  queuedAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
  payload: z.unknown(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type BackgroundJobSummary = z.infer<typeof backgroundJobSummarySchema>;

export const backgroundBatchDetailSchema = z.object({
  ...backgroundBatchSummaryFields,
  jobs: z.array(backgroundJobSummarySchema),
});

export type BackgroundBatchDetail = z.infer<typeof backgroundBatchDetailSchema>;

export const backgroundBatchListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
});

export const backgroundBatchListOutSchema = z.array(
  backgroundBatchSummarySchema,
);

export const backgroundBatchIdInputSchema = z.object({
  batchId: z.string(),
});

export const backgroundBatchJobsInputSchema = z.object({
  batchId: z.string(),
  pageIndex: z.number().int().nonnegative().default(0),
  pageSize: z.number().int().min(1).max(100).default(100),
  failedOnly: z.boolean().default(false),
});

export type BackgroundBatchJobsInput = z.infer<
  typeof backgroundBatchJobsInputSchema
>;

export const backgroundBatchJobsOutSchema = z.object({
  jobs: z.array(backgroundJobSummarySchema),
  totalCount: z.number().int().nonnegative(),
  pageIndex: z.number().int().nonnegative(),
  pageSize: z.number().int().min(1).max(100),
});

export type BackgroundBatchJobsOut = z.infer<
  typeof backgroundBatchJobsOutSchema
>;

export const backgroundJobIdInputSchema = z.object({
  jobId: z.string(),
});

export const backgroundDrainInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
});

export const backgroundDrainOutSchema = z.object({
  processed: z.number().int().nonnegative(),
});
