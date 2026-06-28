import {
  type BackgroundBatchRef,
  type BackgroundBatchSource,
  type BackgroundJobKind,
  backgroundJobPayloadSchema,
} from "@cubby/schemas/background-jobs";
import type { EntityRef } from "@cubby/schemas/entity";
import { unsafeLocationId, unsafeRecipeId } from "@cubby/schemas/identifiers";
import { getBackgroundQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  addBackgroundJobsToBatch,
  type CreateBackgroundJobInput,
  createBackgroundBatchWithJobs,
  failOrRetryBackgroundJob,
  findQueuedBackgroundJobs,
  finishBackgroundJob,
  getBackgroundBatchDetail,
  getBackgroundJob,
  markBackgroundJobRunning,
  setBackgroundBatchProcessor,
  toBackgroundBatchRef,
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
  describeLocation,
  detectInventoryItems,
  isLocationHasNoImagesToAnalyzeError,
} from "./services/ai-enrichment.service";
import { LocationValuationService } from "./services/location-valuation.service";

export const BACKGROUND_MESSAGE_VERSION = 1;

export interface BackgroundQueueMessage {
  messageVersion: number;
  batchId: string;
  jobId: string;
  kind: BackgroundJobKind;
}

export interface BackgroundQueueProducer {
  send(body: BackgroundQueueMessage): Promise<void>;
  sendBatch(
    messages: Iterable<{ body: BackgroundQueueMessage }>,
  ): Promise<void>;
}

export interface BackgroundQueueDeliveredMessage {
  readonly body: BackgroundQueueMessage;
  ack(): void;
  retry(): void;
}

export interface BackgroundQueueBatch {
  readonly messages: readonly BackgroundQueueDeliveredMessage[];
}

interface DispatchBackgroundJobsInput {
  kind: BackgroundJobKind;
  source: BackgroundBatchSource;
  metadata?: unknown;
  batchId?: string;
  jobs: CreateBackgroundJobInput[];
}

export interface DispatchBackgroundJobsResult {
  batchId: string;
  jobIds: string[];
  batch: BackgroundBatchRef;
}

async function getDispatchedBatchRef(
  db: Database,
  batchId: string,
): Promise<BackgroundBatchRef> {
  const detail = await getBackgroundBatchDetail(db, batchId);
  if (!detail) {
    throw new Error(`Background batch ${batchId} was not found after dispatch`);
  }
  return toBackgroundBatchRef(detail);
}

export async function dispatchBackgroundJobs(
  db: Database,
  input: DispatchBackgroundJobsInput,
): Promise<DispatchBackgroundJobsResult> {
  const result = input.batchId
    ? {
        batchId: input.batchId,
        jobIds: await addBackgroundJobsToBatch(db, input.batchId, input.jobs),
      }
    : await createBackgroundBatchWithJobs(db, input);

  if (result.jobIds.length === 0) {
    return {
      ...result,
      batch: await getDispatchedBatchRef(db, result.batchId),
    };
  }

  const queue = getBackgroundQueue();
  if (queue) {
    await setBackgroundBatchProcessor(db, result.batchId, "queue");
    await sendBackgroundMessages(
      queue,
      result.batchId,
      input.kind,
      result.jobIds,
    );
    return {
      ...result,
      batch: await getDispatchedBatchRef(db, result.batchId),
    };
  }

  await setBackgroundBatchProcessor(db, result.batchId, "inline");
  for (const jobId of result.jobIds) {
    await processBackgroundJob(db, jobId);
  }

  return {
    ...result,
    batch: await getDispatchedBatchRef(db, result.batchId),
  };
}

async function sendBackgroundMessages(
  queue: BackgroundQueueProducer,
  batchId: string,
  kind: BackgroundJobKind,
  jobIds: string[],
): Promise<void> {
  for (let i = 0; i < jobIds.length; i += 100) {
    const chunk = jobIds.slice(i, i + 100);
    await queue.sendBatch(
      chunk.map((jobId) => ({
        body: {
          messageVersion: BACKGROUND_MESSAGE_VERSION,
          batchId,
          jobId,
          kind,
        },
      })),
    );
  }
}

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

export async function dispatchLocationValuationRecompute(
  db: Database,
  reason: string,
  entity?: EntityRef,
): Promise<DispatchBackgroundJobsResult> {
  return await dispatchBackgroundJobs(db, {
    kind: "location-valuation.recompute",
    source: "mutation",
    metadata: { source: reason, reason, entity },
    jobs: [
      {
        kind: "location-valuation.recompute",
        dedupeKey: `location-valuation.recompute:${crypto.randomUUID()}`,
        payload: { reason },
      },
    ],
  });
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
