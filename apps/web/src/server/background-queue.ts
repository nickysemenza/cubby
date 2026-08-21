import { backgroundJobPayloadSchema } from "@cubby/schemas/background-jobs";
import {
  unsafeIngredientId,
  unsafeLocationId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import { match } from "ts-pattern";
import { getProblemCountsCache } from "~/server/cf-env";
import { createUpcLookupClient } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import {
  failOrRetryBackgroundJob,
  findQueuedBackgroundJobs,
  finishBackgroundJob,
  getBackgroundJob,
  markBackgroundJobRunning,
} from "~/server/repo/background-jobs";
import { upsertEntityEmbedding } from "~/server/repo/entity-embedding";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/repo/search-document";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import {
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import {
  BACKGROUND_MESSAGE_VERSION,
  type BackgroundQueueDeliveredMessage,
} from "./background-queue-types";
import {
  describeLocation,
  detectInventoryItems,
  isLocationHasNoImagesToAnalyzeError,
} from "./services/ai-enrichment/location-vision";
import { retryUsdaMatch } from "./services/ai-enrichment/usda-match";
import { LocationValuationService } from "./services/location-valuation.service";
import { refreshCachedProblemCounts } from "./services/problem-counts-cache";

export async function processBackgroundQueueMessage(
  db: Database,
  message: BackgroundQueueDeliveredMessage,
): Promise<void> {
  if (message.body.messageVersion !== BACKGROUND_MESSAGE_VERSION) {
    console.warn(
      `[background-queue] dropped stale message version=${String(message.body.messageVersion)} current=${BACKGROUND_MESSAGE_VERSION} batch=${message.body.batchId} job=${message.body.jobId}`,
    );
    message.ack();
    return;
  }

  const outcome = await processBackgroundJob(db, message.body.jobId);
  if (outcome === "retry") {
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
  let processed = 0;
  for (const job of jobs) {
    await processBackgroundJob(db, job.id);
    processed++;
  }
  return { processed };
}

export async function processBackgroundJob(
  db: Database,
  jobId: string,
): Promise<"succeeded" | "skipped" | "retry" | "failed"> {
  const current = await getBackgroundJob(db, jobId);
  if (!current) return "skipped";
  if (
    current.status === "succeeded" ||
    current.status === "skipped" ||
    current.status === "failed" ||
    current.status === "cancelled"
  ) {
    return current.status === "failed" ? "failed" : "skipped";
  }

  const running = await markBackgroundJobRunning(db, jobId);
  if (!running) return "skipped";

  try {
    const parsed = backgroundJobPayloadSchema.parse({
      kind: running.kind,
      payload: running.payload,
    });
    const status = await runBackgroundJobPayload(db, running.batchId, parsed);
    await finishBackgroundJob(db, jobId, status);
    return status;
  } catch (error) {
    console.error(
      `[background-queue] job failed batch=${running.batchId} job=${jobId} kind=${running.kind}`,
      error,
    );
    return await failOrRetryBackgroundJob(db, jobId, error);
  }
}

async function runBackgroundJobPayload(
  db: Database,
  batchId: string,
  parsed: ReturnType<typeof backgroundJobPayloadSchema.parse>,
): Promise<"succeeded" | "skipped"> {
  return match(parsed)
    .with({ kind: "recipe-totals.recompute" }, async (p) => {
      const { recomputeRecipeIds } = await import("./queue-recompute");
      await recomputeRecipeIds({
        database: db,
        recipeIds: p.payload.recipeIds.map((id) => unsafeRecipeId(id)),
        batchId,
      });
      return "succeeded" as const;
    })
    .with({ kind: "entity-embedding.refresh" }, async (p) => {
      const refreshed = await refreshSearchDocument(
        db,
        p.payload.entityType,
        p.payload.entityId,
      );
      if (refreshed.status !== "upserted") return "skipped" as const;
      if (!semanticEmbeddingsConfigured()) return "skipped" as const;
      const text = await getSearchDocumentEmbeddingText(
        db,
        p.payload.entityType,
        p.payload.entityId,
      );
      if (!text) return "skipped" as const;
      const [embedding] = await embedTexts([text.embeddingText], {
        operation: "entityEmbeddingRefresh",
        db,
        feature: "entity-embedding",
        entity: {
          entityType: p.payload.entityType,
          entityId: p.payload.entityId,
        },
        batchId,
      });
      if (!embedding) return "skipped" as const;
      await upsertEntityEmbedding(db, {
        ...text,
        config: getSemanticEmbeddingConfig(),
        embedding,
      });
      return "succeeded" as const;
    })
    .with({ kind: "location-ai.description.refresh" }, async (p) => {
      try {
        await describeLocation(db, unsafeLocationId(p.payload.locationId), {
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
      try {
        await detectInventoryItems(db, unsafeLocationId(p.payload.locationId), {
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
      await new LocationValuationService(db).recompute();
      return "succeeded" as const;
    })
    .with({ kind: "problems.counts.refresh" }, async (p) => {
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
      // Real failures propagate (no catch here) — failOrRetryBackgroundJob is
      // what turns those into the queue's own attempts/backoff.
      await retryUsdaMatch(db, unsafeIngredientId(p.payload.ingredientId));
      return "succeeded" as const;
    })
    .exhaustive();
}
