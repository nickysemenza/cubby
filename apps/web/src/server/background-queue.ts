import { backgroundJobPayloadSchema } from "@cubby/schemas/background-jobs";
import { unsafeLocationId, unsafeRecipeId } from "@cubby/schemas/identifiers";
import type { Database } from "~/server/db";
import {
  failOrRetryBackgroundJob,
  findQueuedBackgroundJobs,
  finishBackgroundJob,
  getBackgroundJob,
  markBackgroundJobRunning,
} from "~/server/repo/background-jobs";
import {
  getEmbeddingTextForEntity,
  upsertEntityEmbedding,
} from "~/server/repo/entity-embedding";
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
import { LocationValuationService } from "./services/location-valuation.service";

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
  switch (parsed.kind) {
    case "recipe-totals.recompute": {
      const { recomputeRecipeIds } = await import("./queue-recompute");
      await recomputeRecipeIds({
        database: db,
        recipeIds: parsed.payload.recipeIds.map((id) => unsafeRecipeId(id)),
        batchId,
      });
      return "succeeded";
    }
    case "entity-embedding.refresh": {
      if (!semanticEmbeddingsConfigured()) return "skipped";
      const text = await getEmbeddingTextForEntity(
        db,
        parsed.payload.entityType,
        parsed.payload.entityId,
      );
      if (!text) return "skipped";
      const [embedding] = await embedTexts([text.embeddingText], {
        operation: "entityEmbeddingRefresh",
        db,
        feature: "entity-embedding",
        entity: {
          entityType: parsed.payload.entityType,
          entityId: parsed.payload.entityId,
        },
        batchId,
      });
      if (!embedding) return "skipped";
      await upsertEntityEmbedding(db, {
        ...text,
        config: getSemanticEmbeddingConfig(),
        embedding,
      });
      return "succeeded";
    }
    case "location-ai.description.refresh": {
      try {
        await describeLocation(
          db,
          unsafeLocationId(parsed.payload.locationId),
          {
            batchId,
          },
        );
      } catch (error) {
        if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped";
        throw error;
      }
      return "succeeded";
    }
    case "location-ai.inventory.refresh": {
      try {
        await detectInventoryItems(
          db,
          unsafeLocationId(parsed.payload.locationId),
          { batchId },
        );
      } catch (error) {
        if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped";
        throw error;
      }
      return "succeeded";
    }
    case "location-valuation.recompute": {
      await new LocationValuationService(db).recompute();
      return "succeeded";
    }
    default: {
      const exhaustive: never = parsed;
      throw new Error(
        `Unsupported background job: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
