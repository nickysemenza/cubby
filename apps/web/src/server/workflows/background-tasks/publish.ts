import {
  backgroundTaskSchema,
  type BackgroundTaskInput,
  type BackgroundTaskReceipt,
} from "@cubby/schemas/background-tasks";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { BACKGROUND_TASK_MESSAGE_VERSION } from "@cubby/schemas/queue-messages";
import { createLogger } from "@cubby/worker-tracing";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { afterResponse, getBackgroundQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers/core";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { repositoryTransactionDatabase } from "~/server/db/repository-access.boundary";
import { imageProcessingJob } from "~/server/db/schema";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

import type { BackgroundQueueProducer } from "../background-queue-types";

const log = createLogger("jobs");
export interface PublishOptions {
  readonly source: string;
}

/** Best-effort wake for intent already committed in Postgres. */
export async function wakeJobs(
  options: PublishOptions & { queue?: BackgroundQueueProducer },
) {
  const queue = options.queue ?? getBackgroundQueue();
  if (!queue) return;
  const send = async () => {
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
  };
  // Only the wake is deferred: callers commit durable intent before getting here.
  // Queue and cron invocations have no request lifetime and still await the send.
  await afterResponse(send());
}

function taskKey(task: BackgroundTaskInput) {
  switch (task.kind) {
    case "maintenance.purchase-discovery":
      return task.kind;
    case "image-processing.wakeup":
      return `image-processing:${task.jobId}`;
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
          .select({
            id: imageProcessingJob.id,
            imageId: imageProcessingJob.imageId,
            kind: imageProcessingJob.kind,
            processorRevision: imageProcessingJob.processorRevision,
            runId: imageProcessingJob.runId,
            state: imageProcessingJob.state,
          })
          .from(imageProcessingJob)
          .where(eq(imageProcessingJob.id, task.jobId));
        if (processing?.state !== "pending") continue;
        const { enqueueImageProcessingExecution } =
          await import("~/server/domains/image-processing/repo/image-processing");
        await enqueueImageProcessingExecution(tx, {
          ...processing,
          runId:
            processing.runId ??
            (task.runId ? parseEntityId("run", task.runId) : null),
        });
        continue;
      }
      if (task.kind === "entity-embedding.refresh") {
        const { enqueueEmbeddingRefs } = await import("./embedding");
        const { prepareSearchDocuments } =
          await import("~/server/generic/search/repo/search-document");
        await enqueueEmbeddingRefs(
          tx,
          await prepareSearchDocuments(tx, [task]),
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
    await runAfterCommit(tx, () => wakeJobs(options));
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
