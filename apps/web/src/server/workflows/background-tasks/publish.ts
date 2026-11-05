import {
  backgroundTaskSchema,
  type BackgroundTaskInput,
  type BackgroundTaskReceipt,
} from "@cubby/schemas/background-tasks";
import { BACKGROUND_TASK_MESSAGE_VERSION } from "@cubby/schemas/queue-messages";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import { afterResponse, getBackgroundQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers/core";
import { repositoryTransactionDatabase } from "~/server/db/repository-access.boundary";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { jobScheduler } from "~/server/generic/jobs/scheduler/client";

import type { BackgroundQueueProducer } from "../background-queue-types";

const log = createLogger("jobs");
export interface PublishOptions {
  readonly source: string;
}

/** Best-effort wake for intent already committed in Postgres. */
export async function wakeJobs(
  options: PublishOptions & { queue?: BackgroundQueueProducer },
) {
  const scheduler = options.queue ? undefined : jobScheduler();
  if (scheduler) {
    await afterResponse(
      (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await scheduler.wake(options.source);
            return;
          } catch (error) {
            log.error("scheduler notification failed", {
              source: options.source,
              attempt,
              error,
            });
          }
        }
        // The queue remains usable if the alarm service is temporarily unavailable.
        const fallback = getBackgroundQueue();
        if (fallback) await wakeJobs({ ...options, queue: fallback });
      })(),
    );
    return;
  }
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
      log.error("wake failed; daily recovery will drain committed jobs", {
        source: options.source,
        error,
      });
    }
  };
  // Only the wake is deferred: callers commit durable intent before getting here.
  // Queue and cron invocations have no request lifetime and still await the send.
  await afterResponse(send());
}

/** A Queue delay at most this long; anything later waits for the hourly cron. */
const MAX_WAKE_DELAY_SECONDS = 3_600;

/**
 * A best-effort wake when known work falls due. Delivery can't be cancelled, so a
 * stale wake touches Postgres once and finds nothing. Work past the delay, and a
 * lost message, are the hourly cron's. `ring` also rings companions for parked
 * device work (`ringDueDeviceWork`).
 */
export async function wakeAt(
  at: Date,
  options: PublishOptions & { ring?: boolean },
) {
  const delaySeconds = Math.max(
    0,
    Math.ceil((at.getTime() - Date.now()) / 1000),
  );
  if (delaySeconds > MAX_WAKE_DELAY_SECONDS) return;
  const queue = getBackgroundQueue();
  if (!queue) return;
  const send = async () => {
    try {
      await queue.sendBatch([
        {
          body: {
            version: BACKGROUND_TASK_MESSAGE_VERSION,
            queueType: "background",
            ...(options.ring ? { ring: true as const } : {}),
          },
          delaySeconds,
        },
      ]);
    } catch (error) {
      log.error("delayed wake failed; the hourly cron will reach this work", {
        source: options.source,
        error,
      });
    }
  };
  await afterResponse(send());
}

function taskKey(task: BackgroundTaskInput) {
  switch (task.kind) {
    case "maintenance.purchase-discovery":
      return task.kind;
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
