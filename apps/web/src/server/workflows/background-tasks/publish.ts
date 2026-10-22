import {
  backgroundTaskSchema,
  type BackgroundTaskInput,
  type BackgroundTaskReceipt,
} from "@cubby/schemas/background-tasks";
import { BACKGROUND_TASK_MESSAGE_VERSION } from "@cubby/schemas/queue-messages";
import { createLogger } from "@cubby/worker-tracing";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getBackgroundQueue, getExecutionCtx } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers/core";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { repositoryTransactionDatabase } from "~/server/db/repository-access.boundary";
import { imageProcessingJob } from "~/server/db/schema";
import { enqueueJob } from "~/server/generic/jobs/repo/jobs";

import type { BackgroundQueueProducer } from "../background-queue-types";

const log = createLogger("jobs");
export interface PublishOptions {
  readonly source: string;
}

/** Queue failure affects latency only. Intent is already committed in Postgres. */
export async function wakeJobs(
  options: PublishOptions & { queue?: BackgroundQueueProducer },
) {
  const queue = options.queue ?? getBackgroundQueue();
  if (!queue) return;
  try {
    await queue.sendBatch([
      {
        body: {
          version: BACKGROUND_TASK_MESSAGE_VERSION,
          queueType: "background",
        },
      },
    ]);
  } catch (error) {
    log.error("wake failed; cron will drain committed jobs", {
      source: options.source,
      error,
    });
  }
}

function taskKey(task: BackgroundTaskInput) {
  switch (task.kind) {
    case "image-processing.wakeup":
      return `image-processing:${task.jobId}`;
    case "entity-embedding.refresh":
      return `embedding:${task.entityKind}:${task.entityId}`;
    case "image-metadata.extract":
      return `image-metadata:${task.imageId}`;
    case "location-ai.description.refresh":
    case "location-ai.inventory.refresh":
      return `${task.kind}:${task.locationId}`;
    case "calendar-feed.mark-dirty":
      return `calendar:${task.origin}`;
    default:
      return `${task.kind}:${crypto.randomUUID()}`;
  }
}

/** Persist using the caller's transaction; the transport carries only a wake. */
export async function publishBackgroundTasks(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<BackgroundTaskReceipt> {
  if (!tasks.length) return { count: 0 };
  await repositoryTransactionDatabase(db, async (tx) => {
    for (const input of tasks) {
      const task = backgroundTaskSchema.parse(input);
      if (task.kind === "image-processing.wakeup") {
        const [processing] = await repositoryQueries(tx)
          .select({ imageId: imageProcessingJob.imageId })
          .from(imageProcessingJob)
          .where(eq(imageProcessingJob.id, task.jobId));
        if (!processing) continue;
        await enqueueJob(tx, {
          key: `image-processing:${task.jobId}`,
          kind: "image.processing",
          subjectKind: "image",
          subjectId: processing.imageId,
          input: { processingId: task.jobId },
          runId: task.runId,
        });
        continue;
      }
      if (task.kind === "entity-embedding.refresh") {
        const { enqueueEmbeddingRefs, productionEmbeddingRefreshPort } =
          await import("./embedding");
        const { prepareSearchDocuments } =
          await import("~/server/generic/search/repo/search-document");
        await enqueueEmbeddingRefs(
          tx,
          await prepareSearchDocuments(tx, [task]),
          productionEmbeddingRefreshPort.config(),
        );
        continue;
      }
      await enqueueJob(tx, {
        key: taskKey(input),
        kind: task.kind,
        ...("locationId" in task
          ? { subjectKind: "location", subjectId: task.locationId }
          : "imageId" in task
            ? { subjectKind: "image", subjectId: task.imageId }
            : task.kind === "calendar-feed.mark-dirty"
              ? { subjectKind: "calendar", subjectId: task.origin }
              : {}),
        input: z.json().parse(JSON.parse(JSON.stringify(input))),
        runId: task.runId,
        invalidate: true,
      });
    }
    await runAfterCommit(tx, () => {
      const wake = wakeJobs(options);
      const ctx = getExecutionCtx();
      if (ctx) {
        ctx.waitUntil(wake);
        return Promise.resolve();
      }
      return wake;
    });
  });
  return { count: tasks.length };
}

export async function enqueueBackgroundTask(
  task: BackgroundTaskInput,
  options: PublishOptions & { queue?: BackgroundQueueProducer },
): Promise<boolean> {
  const { db } = await import("~/server/db");
  await publishBackgroundTasks(db, [task], options);
  return true;
}

export async function publishInBackground(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<void> {
  await publishBackgroundTasks(db, tasks, options);
}

export type BackgroundTaskPublisher = (
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
) => Promise<BackgroundTaskReceipt | void>;
