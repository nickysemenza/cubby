import {
  type BackgroundJobKind,
  backgroundJobPayloadSchema,
} from "@cubby/schemas/background-jobs";
import { backgroundQueueMessageSchema } from "@cubby/schemas/queue-messages";
import { match } from "ts-pattern";

import { getErrorMessage } from "~/lib/error-utils";
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

export async function processBackgroundQueueMessage(
  db: Database,
  message: BackgroundQueueDeliveredMessage,
): Promise<void> {
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
    return;
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
}

export async function drainQueuedBackgroundJobs(
  db: Database,
  limit: number,
): Promise<{ processed: number }> {
  const jobs = await findQueuedBackgroundJobs(db, limit);
  const batchKinds = new Map<string, BackgroundJobKind | undefined>();
  let processed = 0;
  for (const job of jobs) {
    let batchKind = batchKinds.get(job.batchId);
    if (batchKind === undefined && !batchKinds.has(job.batchId)) {
      batchKind = (await getBackgroundBatchSummary(db, job.batchId))?.kind;
      batchKinds.set(job.batchId, batchKind);
    }
    await processBackgroundJob(db, job.id, batchKind);
    processed++;
  }
  return { processed };
}

export async function processBackgroundJob(
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

      try {
        const parsed = backgroundJobPayloadSchema.parse({
          kind: running.kind,
          payload: running.payload,
        });
        const status = await runBackgroundJobPayload(
          db,
          running.batchId,
          parsed,
          embeddingPort,
        );
        await finishBackgroundJob(db, jobId, status);
        if (isBackgroundWorkflowKind(batchKind)) {
          await advanceWorkflowIfReady(db, running.batchId);
        }
        return withOutcome(status);
      } catch (error) {
        console.error(
          `[background-queue] job failed batch=${running.batchId} job=${jobId} kind=${running.kind}`,
          error,
        );
        // failOrRetryBackgroundJob handles the failure and this path returns
        // normally (no rethrow), so withTrace's auto-error-on-throw never
        // fires here — mark the span explicitly or the failure is invisible
        // in traces.
        span.setError(getErrorMessage(error));
        span.recordException(error);
        const outcome = await failOrRetryBackgroundJob(db, jobId, error);
        if (outcome === "failed" && isBackgroundWorkflowKind(batchKind)) {
          await advanceWorkflowIfReady(db, running.batchId);
        }
        return withOutcome(outcome);
      }
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

async function runBackgroundJobPayload(
  db: Database,
  batchId: string,
  parsed: ReturnType<typeof backgroundJobPayloadSchema.parse>,
  embeddingPort: BackgroundQueueEmbeddingPort,
): Promise<"succeeded" | "skipped"> {
  return match(parsed)
    .with({ kind: "recipe-totals.recompute" }, async (p) => {
      const { recomputeRecipeIds } = await import("./queue-recompute");
      await recomputeRecipeIds({
        database: db,
        recipeIds: p.payload.recipeIds,
        batchId,
      });
      return "succeeded" as const;
    })
    .with({ kind: "entity-embedding.refresh" }, async (p) => {
      const { ref } = p.payload;
      const refreshed = await refreshSearchDocument(db, ref.entity, ref.id);
      if (refreshed.status !== "upserted") return "skipped" as const;
      const text = await getSearchDocumentEmbeddingText(db, ref.entity, ref.id);
      if (!text) return "skipped" as const;
      // Computed unconditionally now: a sha256 over already-loaded text is
      // nothing next to the HTTP embedding call it can avoid below.
      const config = embeddingPort.config();
      const currentHash = await embeddingTextHash({
        entityType: text.entityType,
        provider: config.provider,
        model: config.model,
        dimensions: config.dimensions,
        text: normalizeSearchText(text.embeddingText),
      });
      if (p.payload.expectedEmbeddingHash) {
        // The workflow inspected a different document revision. Refresh is
        // already complete above; persist a replacement child keyed by the
        // current hash so this same workflow still converges without paying a
        // provider call for the obsolete input.
        if (currentHash !== p.payload.expectedEmbeddingHash) {
          const jobIds = await addBackgroundJobsToBatch(db, batchId, [
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
          if (jobIds.length > 0) {
            const { dispatchQueuedBackgroundJobs } =
              await import("./background-dispatch");
            await dispatchQueuedBackgroundJobs(db, {
              batchId,
              jobIds,
              batchKind: "entity-embedding.backfill.coordinator",
            });
          }
          return "skipped" as const;
        }
      }
      // Nothing about the embedded text changed, so the vector we would get
      // back is the one already stored. Mutation-sourced refreshes fan out on
      // every edit and carry no expected hash, so this is the common case, not
      // the exception — skipping here is what keeps a re-projection free.
      const storedHash = await getStoredEmbeddingHash(db, {
        entityType: text.entityType,
        entityId: text.entityId,
        config,
      });
      if (storedHash === currentHash) return "skipped" as const;

      if (!embeddingPort.configured()) return "skipped" as const;
      const [embedding] = await embeddingPort.embed([text.embeddingText], {
        operation: "entityEmbeddingRefresh",
        db,
        feature: "entity-embedding",
        entity: {
          entityType: ref.entity,
          entityId: ref.id,
        },
        batchId,
      });
      if (!embedding) return "skipped" as const;
      await upsertEntityEmbedding(db, {
        ...text,
        config,
        embedding,
      });
      return "succeeded" as const;
    })
    .with({ kind: "entity-embedding.backfill.coordinator" }, async (p) => {
      const { continueEntityEmbeddingBackfillWorkflow } =
        await import("./services/semantic-search.service");
      return await continueEntityEmbeddingBackfillWorkflow(
        db,
        batchId,
        p.payload,
      );
    })
    .with({ kind: "search-document.repair.coordinator" }, async (p) => {
      const { continueSearchDocumentRepairWorkflow } =
        await import("./services/search.service");
      return await continueSearchDocumentRepairWorkflow(db, batchId, p.payload);
    })
    .with({ kind: "location-ai.description.refresh" }, async (p) => {
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
        if (isLocationHasNoImagesToAnalyzeError(error))
          return "skipped" as const;
        throw error;
      }
      return "succeeded" as const;
    })
    .with({ kind: "location-ai.inventory.refresh" }, async (p) => {
      const { detectInventoryItems, isLocationHasNoImagesToAnalyzeError } =
        await import("./services/ai-enrichment/location-vision");
      try {
        await detectInventoryItems(db, p.payload.locationId, {
          batchId,
        });
      } catch (error) {
        if (isLocationHasNoImagesToAnalyzeError(error))
          return "skipped" as const;
        throw error;
      }
      return "succeeded" as const;
    })
    .with({ kind: "location-valuation.recompute" }, async () => {
      const { LocationValuationService } =
        await import("./services/location-valuation.service");
      await new LocationValuationService(db).recompute();
      return "succeeded" as const;
    })
    .with({ kind: "problems.counts.refresh" }, async (p) => {
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
    .with({ kind: "usda-match.retry" }, async (p) => {
      const { retryUsdaMatch } =
        await import("./services/ai-enrichment/usda-match");
      // Real failures propagate (no catch here) — failOrRetryBackgroundJob is
      // what turns those into the queue's own attempts/backoff.
      await retryUsdaMatch(db, p.payload.ingredientId);
      return "succeeded" as const;
    })
    .exhaustive();
}
