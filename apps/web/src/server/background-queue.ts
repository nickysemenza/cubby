import {
  type BackgroundJobKind,
  backgroundJobPayloadSchema,
} from "@cubby/schemas/background-jobs";
import { backgroundQueueMessageSchema } from "@cubby/schemas/queue-messages";

import { getErrorMessage } from "~/lib/error-utils";
import {
  executeBackgroundJobDelivery,
  type BackgroundJobDeliveryDefinition,
} from "~/server/background-job-delivery";
import {
  advanceWorkflowIfReady,
  isBackgroundWorkflowKind,
} from "~/server/background-workflow";
import { getProblemCountsCache } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  addBackgroundJobsToBatch,
  BACKGROUND_JOB_LEASE_MS,
  failOrRetryBackgroundJob,
  findQueuedBackgroundJobs,
  finishBackgroundJob,
  getBackgroundBatchSummary,
  getBackgroundJob,
  markBackgroundJobRunning,
} from "~/server/repo/background-jobs";
import {
  getStoredEmbeddingHash,
  upsertEntityEmbedding,
} from "~/server/repo/entity-embedding";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/repo/search-document";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import {
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import { embeddingTextHash } from "~/server/semantic/hash";
import { normalizeSearchText } from "~/server/semantic/text";
import { TraceNames, withTrace } from "~/server/tracing";
import {
  workflow,
  bindWorkflow,
  type WorkflowDefinition,
} from "~/server/workflow-runtime";

import type { BackgroundQueueDeliveredMessage } from "./background-queue-types";

/** Outcome of one job attempt; drives the queue ack/retry decision. */
export type BackgroundJobOutcome =
  | "succeeded"
  | "skipped"
  | "retry"
  | "failed"
  | "leased";

export interface BackgroundQueueEmbeddingPort {
  readonly configured: () => boolean;
  readonly embed: typeof embedTexts;
  readonly config: typeof getSemanticEmbeddingConfig;
}

const productionBackgroundQueueEmbeddingPort: BackgroundQueueEmbeddingPort = {
  configured: semanticEmbeddingsConfigured,
  embed: embedTexts,
  config: getSemanticEmbeddingConfig,
};

type DeliveryContext = {
  readonly db: Database;
  readonly jobId: string;
  readonly batchId: string;
  readonly batchKind?: BackgroundJobKind;
  readonly embeddingPort: BackgroundQueueEmbeddingPort;
};

type ParsedBackgroundJob = ReturnType<typeof backgroundJobPayloadSchema.parse>;
type DeliveryStatus = "succeeded" | "skipped";

type EntityEmbeddingPayload = Extract<
  ParsedBackgroundJob,
  { readonly kind: "entity-embedding.refresh" }
>;

type EmbeddingRevision = {
  text: NonNullable<Awaited<ReturnType<typeof getSearchDocumentEmbeddingText>>>;
  config: ReturnType<typeof getSemanticEmbeddingConfig>;
  currentHash: string;
  expectedHash: string | undefined;
};

const persistEmbeddingWorkflow = workflow<
  DeliveryContext,
  EmbeddingRevision & { embedding: number[] }
>("background-job.embedding.persist")
  .commit("upsert", ({ context }, { input }) =>
    upsertEntityEmbedding(context.db, {
      ...input.text,
      config: input.config,
      embedding: input.embedding,
    }),
  )
  .output(() => "succeeded" as const);

const requestEmbeddingWorkflow: WorkflowDefinition<
  DeliveryContext,
  EmbeddingRevision,
  DeliveryStatus
> = workflow<DeliveryContext, EmbeddingRevision>(
  "background-job.embedding.request",
)
  .call("embedding", async ({ context }, { input }) => {
    const [embedding] = await context.embeddingPort.embed(
      [input.text.embeddingText],
      {
        operation: "entityEmbeddingRefresh",
        db: context.db,
        feature: "entity-embedding",
        entity: {
          entityType: input.text.entityType,
          entityId: input.text.entityId,
        },
        batchId: context.batchId,
      },
    );
    return embedding;
  })
  .mapWorkflow("persist", {
    items: ({ input, embedding }) =>
      embedding ? [{ ...input, embedding }] : [],
    concurrency: 1,
    workflow: persistEmbeddingWorkflow,
  })
  .output(({ persist }) => persist[0] ?? "skipped");

const currentEmbeddingRevisionWorkflow: WorkflowDefinition<
  DeliveryContext,
  EmbeddingRevision,
  DeliveryStatus
> = workflow<DeliveryContext, EmbeddingRevision>(
  "background-job.embedding.currentRevision",
)
  .call("storedHash", ({ context }, { input }) =>
    getStoredEmbeddingHash(context.db, {
      entityType: input.text.entityType,
      entityId: input.text.entityId,
      config: input.config,
    }),
  )
  .call("configured", async ({ context }) => context.embeddingPort.configured())
  .mapWorkflow("request", {
    // The common mutation fan-out path reprojects unchanged text. Compare its
    // hash before requesting a vector, not merely before storing the result.
    items: ({ input, storedHash, configured }) =>
      configured && storedHash !== input.currentHash ? [input] : [],
    concurrency: 1,
    workflow: requestEmbeddingWorkflow,
  })
  .output(({ request }) => request[0] ?? "skipped");

const replaceEmbeddingRevisionWorkflow: WorkflowDefinition<
  DeliveryContext,
  EmbeddingRevision,
  DeliveryStatus
> = workflow<DeliveryContext, EmbeddingRevision>(
  "background-job.embedding.replaceRevision",
)
  .commit("replacementJobs", ({ context }, { input }) => {
    const { text, currentHash } = input;
    // Keep replacements in the inspected batch, deduplicated by their current
    // hash, so stale work converges without paying for an obsolete document.
    return addBackgroundJobsToBatch(context.db, context.batchId, [
      {
        kind: "entity-embedding.refresh",
        dedupeKey: `entity-embedding.refresh:${text.entityType}:${text.entityId}:${currentHash}`,
        payload: {
          entityType: text.entityType,
          entityId: text.entityId,
          expectedEmbeddingHash: currentHash,
        },
      },
    ]);
  })
  .effect("dispatchReplacement", async ({ context }, { replacementJobs }) => {
    if (replacementJobs.length === 0) return;
    const { dispatchQueuedBackgroundJobs } =
      await import("./background-dispatch");
    await dispatchQueuedBackgroundJobs(context.db, {
      batchId: context.batchId,
      jobIds: replacementJobs,
      batchKind: "entity-embedding.backfill.coordinator",
    });
  })
  .output(() => "skipped" as const);

type EmbeddingDocument = {
  text: EmbeddingRevision["text"];
  expectedHash: string | undefined;
};
const embeddingRevisionWorkflow: WorkflowDefinition<
  DeliveryContext,
  EmbeddingDocument,
  DeliveryStatus
> = workflow<DeliveryContext, EmbeddingDocument>(
  "background-job.embedding.revision",
)
  .call(
    "revision",
    async ({ context }, { input }): Promise<EmbeddingRevision> => {
      const config = context.embeddingPort.config();
      const currentHash = await embeddingTextHash({
        entityType: input.text.entityType,
        provider: config.provider,
        model: config.model,
        dimensions: config.dimensions,
        text: normalizeSearchText(input.text.embeddingText),
      });
      return { ...input, config, currentHash };
    },
  )
  .branch("obsoleteRevision", {
    when: async (_, { revision }) =>
      !!revision.expectedHash && revision.expectedHash !== revision.currentHash,
    whenTrue: (branch) =>
      branch
        .mapWorkflow("replacement", {
          items: ({ input }) => [input.revision],
          concurrency: 1,
          workflow: replaceEmbeddingRevisionWorkflow,
        })
        .output(({ replacement }) => replacement[0] ?? "skipped"),
    whenFalse: (branch) =>
      branch
        .mapWorkflow("current", {
          items: ({ input }) => [input.revision],
          concurrency: 1,
          workflow: currentEmbeddingRevisionWorkflow,
        })
        .output(({ current }) => current[0] ?? "skipped"),
  })
  .output(({ obsoleteRevision }) => obsoleteRevision);

const embeddingDocumentWorkflow: WorkflowDefinition<
  DeliveryContext,
  EntityEmbeddingPayload,
  DeliveryStatus
> = workflow<DeliveryContext, EntityEmbeddingPayload>(
  "background-job.embedding.document",
)
  .call("text", ({ context }, { input }) =>
    getSearchDocumentEmbeddingText(
      context.db,
      input.payload.ref.entity,
      input.payload.ref.id,
    ),
  )
  .mapWorkflow("revision", {
    items: ({ input, text }) =>
      text ? [{ text, expectedHash: input.payload.expectedEmbeddingHash }] : [],
    concurrency: 1,
    workflow: embeddingRevisionWorkflow,
  })
  .output(({ revision }) => revision[0] ?? "skipped");

// Child definitions keep the complete payload inspectable while placing a
// finite type boundary around each provider, revision, and persistence stage.
const entityEmbeddingPayloadWorkflow: WorkflowDefinition<
  DeliveryContext,
  EntityEmbeddingPayload,
  DeliveryStatus
> = workflow<DeliveryContext, EntityEmbeddingPayload>(
  "background-job.payload.entityEmbeddingRefresh",
)
  .commit("refreshDocument", ({ context }, { input }) =>
    refreshSearchDocument(
      context.db,
      input.payload.ref.entity,
      input.payload.ref.id,
    ),
  )
  .mapWorkflow("document", {
    items: ({ input, refreshDocument }) =>
      refreshDocument.status === "upserted" ? [input] : [],
    concurrency: 1,
    workflow: embeddingDocumentWorkflow,
  })
  .output(({ document }) => document[0] ?? "skipped");

const recipe_totals_recomputeWorkflow = workflow<
  DeliveryContext,
  Extract<ParsedBackgroundJob, { kind: "recipe-totals.recompute" }>
>("background-job.payload.recipe-totals.recompute")
  .commit("execute", async ({ context }, { input: p }) => {
    const { db, batchId } = context;

    const { recomputeRecipeIds } = await import("./queue-recompute");
    await recomputeRecipeIds({
      database: db,
      recipeIds: p.payload.recipeIds,
      batchId,
    });
    return "succeeded" as const;
  })
  .output(({ execute }) => execute);

const entity_embedding_backfill_coordinatorWorkflow = workflow<
  DeliveryContext,
  Extract<
    ParsedBackgroundJob,
    { kind: "entity-embedding.backfill.coordinator" }
  >
>("background-job.payload.entity-embedding.backfill.coordinator")
  .commit("execute", async ({ context }, { input: p }) => {
    const { db, batchId } = context;

    const { continueEntityEmbeddingBackfillWorkflow } =
      await import("./services/semantic-search.service");
    return await continueEntityEmbeddingBackfillWorkflow(
      db,
      batchId,
      p.payload,
    );
  })
  .output(({ execute }) => execute);

const search_document_repair_coordinatorWorkflow = workflow<
  DeliveryContext,
  Extract<ParsedBackgroundJob, { kind: "search-document.repair.coordinator" }>
>("background-job.payload.search-document.repair.coordinator")
  .commit("execute", async ({ context }, { input: p }) => {
    const { db, batchId } = context;

    const { continueSearchDocumentRepairWorkflow } =
      await import("./services/search.service");
    return await continueSearchDocumentRepairWorkflow(db, batchId, p.payload);
  })
  .output(({ execute }) => execute);

const location_ai_description_refreshWorkflow = workflow<
  DeliveryContext,
  Extract<ParsedBackgroundJob, { kind: "location-ai.description.refresh" }>
>("background-job.payload.location-ai.description.refresh")
  .commit("execute", async ({ context }, { input: p }) => {
    const { db, batchId } = context;

    // Location vision reaches browser-facing feature flags. Keep it out of
    // the common worker module so maintenance can drain embedding-only work
    // in a plain Node runtime.
    const { describeLocation, isLocationHasNoImagesToAnalyzeError } =
      await import("./services/ai-enrichment/location-vision");
    try {
      await describeLocation(db, p.payload.locationId, {
        batchId,
      });
    } catch (error) {
      if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped" as const;
      throw error;
    }
    return "succeeded" as const;
  })
  .output(({ execute }) => execute);

const location_ai_inventory_refreshWorkflow = workflow<
  DeliveryContext,
  Extract<ParsedBackgroundJob, { kind: "location-ai.inventory.refresh" }>
>("background-job.payload.location-ai.inventory.refresh")
  .commit("execute", async ({ context }, { input: p }) => {
    const { db, batchId } = context;

    const { detectInventoryItems, isLocationHasNoImagesToAnalyzeError } =
      await import("./services/ai-enrichment/location-vision");
    try {
      await detectInventoryItems(db, p.payload.locationId, {
        batchId,
      });
    } catch (error) {
      if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped" as const;
      throw error;
    }
    return "succeeded" as const;
  })
  .output(({ execute }) => execute);

const location_valuation_recomputeWorkflow = workflow<
  DeliveryContext,
  Extract<ParsedBackgroundJob, { kind: "location-valuation.recompute" }>
>("background-job.payload.location-valuation.recompute")
  .commit("execute", async ({ context }) => {
    const { db } = context;

    const { LocationValuationService } =
      await import("./services/location-valuation.service");
    await new LocationValuationService(db).recompute();
    return "succeeded" as const;
  })
  .output(({ execute }) => execute);

const problems_counts_refreshWorkflow = workflow<
  DeliveryContext,
  Extract<ParsedBackgroundJob, { kind: "problems.counts.refresh" }>
>("background-job.payload.problems.counts.refresh")
  .commit("execute", async ({ context }, { input: p }) => {
    const { db } = context;

    const { createUpcLookupClient } =
      await import("~/server/clients/upc-lookup");
    const { refreshCachedProblemCounts } =
      await import("./services/problem-counts-cache");
    const cache = getProblemCountsCache();
    if (!cache) return "skipped" as const;
    return await refreshCachedProblemCounts(
      db,
      createUpcLookupClient(),
      cache,
      p.payload.requestedAt,
    );
  })
  .output(({ execute }) => execute);

const usda_match_retryWorkflow = workflow<
  DeliveryContext,
  Extract<ParsedBackgroundJob, { kind: "usda-match.retry" }>
>("background-job.payload.usda-match.retry")
  .commit("execute", async ({ context }, { input: p }) => {
    const { db } = context;

    const { retryUsdaMatch } =
      await import("./services/ai-enrichment/usda-match");
    // Real failures propagate (no catch here) — failOrRetryBackgroundJob is
    // what turns those into the queue's own attempts/backoff.
    await retryUsdaMatch(db, p.payload.ingredientId);
    return "succeeded" as const;
  })
  .output(({ execute }) => execute);

const payloadDeliveryWorkflow: WorkflowDefinition<
  DeliveryContext,
  unknown,
  DeliveryStatus
> = workflow<DeliveryContext, unknown>("background-job.delivery.payload")
  .call("parsed", async (_, { input }) =>
    backgroundJobPayloadSchema.parse(input),
  )
  .mapWorkflow("recipe_totals_recompute", {
    items: ({ parsed }) =>
      parsed.kind === "recipe-totals.recompute" ? [parsed] : [],
    concurrency: 1,
    workflow: recipe_totals_recomputeWorkflow,
  })
  .mapWorkflow("entityEmbedding", {
    items: ({ parsed }) =>
      parsed.kind === "entity-embedding.refresh" ? [parsed] : [],
    concurrency: 1,
    workflow: entityEmbeddingPayloadWorkflow,
  })
  .mapWorkflow("entity_embedding_backfill_coordinator", {
    items: ({ parsed }) =>
      parsed.kind === "entity-embedding.backfill.coordinator" ? [parsed] : [],
    concurrency: 1,
    workflow: entity_embedding_backfill_coordinatorWorkflow,
  })
  .mapWorkflow("search_document_repair_coordinator", {
    items: ({ parsed }) =>
      parsed.kind === "search-document.repair.coordinator" ? [parsed] : [],
    concurrency: 1,
    workflow: search_document_repair_coordinatorWorkflow,
  })
  .mapWorkflow("location_ai_description_refresh", {
    items: ({ parsed }) =>
      parsed.kind === "location-ai.description.refresh" ? [parsed] : [],
    concurrency: 1,
    workflow: location_ai_description_refreshWorkflow,
  })
  .mapWorkflow("location_ai_inventory_refresh", {
    items: ({ parsed }) =>
      parsed.kind === "location-ai.inventory.refresh" ? [parsed] : [],
    concurrency: 1,
    workflow: location_ai_inventory_refreshWorkflow,
  })
  .mapWorkflow("location_valuation_recompute", {
    items: ({ parsed }) =>
      parsed.kind === "location-valuation.recompute" ? [parsed] : [],
    concurrency: 1,
    workflow: location_valuation_recomputeWorkflow,
  })
  .mapWorkflow("problems_counts_refresh", {
    items: ({ parsed }) =>
      parsed.kind === "problems.counts.refresh" ? [parsed] : [],
    concurrency: 1,
    workflow: problems_counts_refreshWorkflow,
  })
  .mapWorkflow("usda_match_retry", {
    items: ({ parsed }) => (parsed.kind === "usda-match.retry" ? [parsed] : []),
    concurrency: 1,
    workflow: usda_match_retryWorkflow,
  })
  .output(
    ({
      recipe_totals_recompute,
      entityEmbedding,
      entity_embedding_backfill_coordinator,
      search_document_repair_coordinator,
      location_ai_description_refresh,
      location_ai_inventory_refresh,
      location_valuation_recompute,
      problems_counts_refresh,
      usda_match_retry,
    }) => {
      const status = [
        ...recipe_totals_recompute,
        ...entityEmbedding,
        ...entity_embedding_backfill_coordinator,
        ...search_document_repair_coordinator,
        ...location_ai_description_refresh,
        ...location_ai_inventory_refresh,
        ...location_valuation_recompute,
        ...problems_counts_refresh,
        ...usda_match_retry,
      ][0];
      if (!status) throw new Error("No declared background payload handler");
      return status;
    },
  );

const finishDeliveryWorkflow = workflow<
  DeliveryContext,
  { readonly status: DeliveryStatus }
>("background-job.delivery.finish")
  .commit("finishJob", async ({ context }, { input }) => {
    await finishBackgroundJob(context.db, context.jobId, input.status);
  })
  .output(() => undefined);

const advanceDeliveryWorkflow = workflow<DeliveryContext, undefined>(
  "background-job.delivery.advance",
)
  .call("advanceWorkflow", async ({ context }) => {
    if (isBackgroundWorkflowKind(context.batchKind))
      await advanceWorkflowIfReady(context.db, context.batchId);
  })
  .output(() => undefined);

const failOrRetryDeliveryWorkflow = workflow<
  DeliveryContext,
  { readonly error: unknown }
>("background-job.delivery.failOrRetry")
  .commit(
    "settleFailure",
    async ({ context }, { input }) =>
      await failOrRetryBackgroundJob(context.db, context.jobId, input.error),
  )
  .output(({ settleFailure }) => settleFailure);

const failedAdvanceDeliveryWorkflow = workflow<DeliveryContext, undefined>(
  "background-job.delivery.failedAdvance",
)
  .call("advanceWorkflow", async ({ context }) => {
    if (isBackgroundWorkflowKind(context.batchKind))
      await advanceWorkflowIfReady(context.db, context.batchId);
  })
  .output(() => undefined);

const backgroundJobDeliveryDefinition: BackgroundJobDeliveryDefinition<
  DeliveryContext,
  unknown,
  DeliveryStatus,
  BackgroundJobOutcome
> = {
  name: "background-job.delivery",
  payload: payloadDeliveryWorkflow,
  finish: finishDeliveryWorkflow,
  advance: advanceDeliveryWorkflow,
  failOrRetry: failOrRetryDeliveryWorkflow,
  failedAdvance: failedAdvanceDeliveryWorkflow,
};

export async function processBackgroundQueueMessage(
  db: Database,
  message: BackgroundQueueDeliveredMessage,
): Promise<BackgroundJobOutcome> {
  const parsed = backgroundQueueMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    // Ack, don't retry. A body this consumer cannot read will not become
    // readable on redelivery — retrying only burns the delivery budget and
    // dead-letters it three attempts later. Stale-version messages land here
    // too, since `version` is a literal in the schema.
    console.warn("[background-queue] dropped invalid queue message", {
      issues: parsed.error.issues,
    });
    message.ack();
    return "skipped";
  }
  const { batchId, jobId, kind } = parsed.data;

  // Per-message clock: a batch is processed serially in this one invocation,
  // so capture t0 at each message's start (NOT at batch arrival) or
  // `duration_ms` would accumulate across the batch.
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  let outcome: BackgroundJobOutcome;
  try {
    outcome = await processBackgroundJob(db, jobId, kind);
  } catch (error) {
    // Logged here rather than in the caller: the caller only has the raw
    // unparsed body, so these identifying fields exist only past the parse.
    console.error(
      `[background-queue] message failed batch=${batchId} job=${jobId} kind=${kind} duration_ms=${elapsed()}`,
      error,
    );
    throw error;
  }
  console.log(
    `[background-queue] message handled batch=${batchId} job=${jobId} kind=${kind} outcome=${outcome} duration_ms=${elapsed()}`,
  );

  if (outcome === "leased") {
    message.retry({
      delaySeconds: Math.ceil(BACKGROUND_JOB_LEASE_MS / 1_000),
    });
  } else if (outcome === "retry") {
    message.retry();
  } else {
    message.ack();
  }
  return outcome;
}

type QueuedDelivery = {
  job: Awaited<ReturnType<typeof findQueuedBackgroundJobs>>[number];
  batchKinds: Map<string, BackgroundJobKind | undefined>;
};
const queuedDeliveryWorkflow = workflow<Database, QueuedDelivery>(
  "background-job.drain.item",
)
  .call("batchKind", async ({ context }, { input }) => {
    const { job, batchKinds } = input;
    if (!batchKinds.has(job.batchId)) {
      batchKinds.set(
        job.batchId,
        (await getBackgroundBatchSummary(context, job.batchId))?.kind,
      );
    }
    return batchKinds.get(job.batchId);
  })
  .commit("deliver", ({ context }, { input, batchKind }) =>
    processBackgroundJob(context, input.job.id, batchKind),
  )
  .output(({ deliver }) => deliver);

export const drainQueuedBackgroundJobs = bindWorkflow(
  workflow<Database, { limit: number }>("background-job.drain")
    .call("queuedJobs", ({ context }, { input }) =>
      findQueuedBackgroundJobs(context, input.limit),
    )
    .call(
      "batchKinds",
      async () => new Map<string, BackgroundJobKind | undefined>(),
    )
    .mapWorkflow("deliveries", {
      items: ({ queuedJobs, batchKinds }) =>
        queuedJobs.map((job) => ({ job, batchKinds })),
      concurrency: 1,
      workflow: queuedDeliveryWorkflow,
    })
    // Every selected delivery counts, including skipped, failed, or leased jobs.
    .output(({ deliveries }) => ({ processed: deliveries.length })),
  (context: Database, limit: number) => ({ context, input: { limit } }),
);

async function processBackgroundJobImplementation(
  db: Database,
  jobId: string,
  batchKind?: BackgroundJobKind,
  embeddingPort: BackgroundQueueEmbeddingPort = productionBackgroundQueueEmbeddingPort,
): Promise<BackgroundJobOutcome> {
  // The job kind isn't known until this read returns, and a missing job is a
  // non-event — both stay outside the span below.
  const current = await getBackgroundJob(db, jobId);
  if (!current) return "skipped";

  return withTrace(
    TraceNames.job(current.kind),
    async (span) => {
      const withOutcome = (status: BackgroundJobOutcome) => {
        span.setAttribute("cubby.job.outcome", status);
        return status;
      };

      if (
        current.status === "running" &&
        current.startedAt &&
        current.startedAt.getTime() > Date.now() - BACKGROUND_JOB_LEASE_MS
      ) {
        // A duplicate delivery can race the live worker. Ask the queue to retry
        // instead of acknowledging it; once the lease expires, markRunning below
        // reclaims work that a crashed worker left behind.
        return withOutcome("leased");
      }
      if (
        current.status === "succeeded" ||
        current.status === "skipped" ||
        current.status === "failed" ||
        current.status === "cancelled"
      ) {
        return withOutcome(current.status === "failed" ? "failed" : "skipped");
      }

      const running = await markBackgroundJobRunning(db, jobId);
      if (!running) return withOutcome("skipped");

      const payload = { kind: running.kind, payload: running.payload };
      return withOutcome(
        await executeBackgroundJobDelivery(backgroundJobDeliveryDefinition, {
          context: {
            db,
            jobId,
            batchId: running.batchId,
            batchKind,
            embeddingPort,
          },
          payload,
          onError: (error) => {
            console.error(
              `[background-queue] job failed batch=${running.batchId} job=${jobId} kind=${running.kind}`,
              error,
            );
            span.setError(getErrorMessage(error));
            span.recordException(error);
          },
        }),
      );
    },
    {
      "cubby.job.id": jobId,
      "cubby.job.batch_id": current.batchId,
      "cubby.job.kind": current.kind,
      "cubby.job.batch_kind": batchKind,
      "cubby.job.attempt": current.attempts,
    },
  );
}

export const processBackgroundJob = Object.assign(
  processBackgroundJobImplementation,
  { definition: backgroundJobDeliveryDefinition },
);
