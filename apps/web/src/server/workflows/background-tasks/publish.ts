import {
  backgroundTaskSchema,
  type BackgroundTaskInput,
  type BackgroundTaskReceipt,
} from "@cubby/schemas/background-tasks";
import {
  BACKGROUND_TASK_MESSAGE_VERSION,
  type PermitRecovery,
} from "@cubby/schemas/queue-messages";
import { retryWithBackoff } from "@cubby/shared/retry";
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import { afterResponse, getBackgroundQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers/core";
import { repositoryTransactionDatabase } from "~/server/db/repository-access.boundary";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

import type { BackgroundQueueProducer } from "../background-queue-types";
import { backgroundTaskJobKey } from "./kinds";

const logger = createLogger("jobs");
export interface PublishOptions {
  readonly source: string;
}

type WakeMessage =
  Parameters<BackgroundQueueProducer["sendBatch"]>[0] extends Iterable<infer M>
    ? M
    : never;

/**
 * Waits between producer attempts. A member's Run can have no other wake, so a transient
 * send failure is retried here and not left for the next hourly tick. The queue's own
 * `maxRetries` cannot help, because a failed send never enqueued anything. The total fits
 * the 30 seconds `waitUntil` allows after a response.
 */
const WAKE_RETRY_DELAYS_MS = [250, 1_000, 4_000];

/** Send a wake, retrying a failed send. Exhaustion leaves the work to the hourly cron. */
async function sendWake(
  queue: BackgroundQueueProducer,
  message: () => WakeMessage,
  log: { source: string; exhausted: string },
) {
  try {
    await retryWithBackoff(() => queue.sendBatch([message()]), {
      delayFor: (outcome, attempt) =>
        outcome.ok ? null : (WAKE_RETRY_DELAYS_MS[attempt] ?? null),
    });
  } catch (error) {
    logger.error(log.exhausted, { source: log.source, error });
  }
}

/** Best-effort permit for intent already committed in Postgres. */
export async function wakeJobs(
  options: PublishOptions & { queue?: BackgroundQueueProducer },
) {
  const queue = options.queue ?? getBackgroundQueue();
  if (!queue) return;
  // Only the wake is deferred: callers commit durable intent before getting here.
  // Queue and cron invocations have no request lifetime and still await the send.
  await afterResponse(
    sendWake(
      queue,
      () => ({
        body: {
          version: BACKGROUND_TASK_MESSAGE_VERSION,
          queueType: "background",
        },
      }),
      {
        source: options.source,
        exhausted: "wake failed; the hourly cron will drain committed work",
      },
    ),
  );
}

/** Cloudflare Queues' longest delivery delay; anything later waits for the hourly cron. */
const MAX_WAKE_DELAY_SECONDS = 12 * 3_600;

/**
 * A best-effort wake when known work falls due. Delivery can't be cancelled, so a
 * stale wake touches Postgres once and finds nothing. Work past the delay, and a
 * lost message, are the hourly cron's. `ring` also rings companions for parked
 * device work (`ringDueDeviceWork`).
 */
export async function wakeAt(
  at: Date,
  options: PublishOptions & { ring?: boolean; recover?: PermitRecovery },
) {
  const delayFromNow = () =>
    Math.max(0, Math.ceil((at.getTime() - Date.now()) / 1000));
  if (delayFromNow() > MAX_WAKE_DELAY_SECONDS) return;
  const queue = getBackgroundQueue();
  if (!queue) return;
  await afterResponse(
    sendWake(
      queue,
      () => ({
        body: {
          version: BACKGROUND_TASK_MESSAGE_VERSION,
          queueType: "background",
          ...(options.ring ? { ring: true as const } : {}),
          ...(options.recover ? { recover: options.recover } : {}),
        },
        // A retry still lands when the work is due.
        delaySeconds: delayFromNow(),
      }),
      {
        source: options.source,
        exhausted: "delayed wake failed; the hourly cron will reach this work",
      },
    ),
  );
}

/** Persist using the caller's transaction; the transport carries only a wake. */
export async function publishBackgroundTasks(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<BackgroundTaskReceipt> {
  if (!tasks.length) return { count: 0 };
  await repositoryTransactionDatabase(db, async (tx) => {
    const parsed = tasks.map((input) => backgroundTaskSchema.parse(input));
    const embeddingTasks = [
      ...new Map(
        parsed
          .filter((task) => task.kind === "entity-embedding.refresh")
          .map((task) => [`${task.entityKind}:${task.entityId}`, task]),
      ).values(),
    ];
    if (embeddingTasks.length) {
      const { enqueueEmbeddingRefs } = await import("./embedding");
      const { prepareSearchDocuments, publishPreparedSearchDocuments } =
        await import("~/server/generic/search/repo/search-document");
      for (let offset = 0; offset < embeddingTasks.length; offset += 200) {
        const prepared = await prepareSearchDocuments(
          tx,
          embeddingTasks.slice(offset, offset + 200),
        );
        await publishPreparedSearchDocuments(tx, prepared);
        await enqueueEmbeddingRefs(tx, prepared);
      }
    }
    for (const task of parsed) {
      if (task.kind === "entity-embedding.refresh") continue;
      if (task.kind === "maintenance.purchase-discovery") {
        const { purchaseDiscoveryPass } =
          await import("../purchase-discovery-pass");
        const { startPass } = await import("~/server/kernel/api");
        await startPass(tx, purchaseDiscoveryPass, {
          cursor: { senderAfter: task.senderAfter ?? null },
        });
        continue;
      }
      if (task.kind === "calendar-feed.mark-dirty") {
        const { calendarInvalidatePass } =
          await import("../calendar-invalidate-pass");
        const { startPass } = await import("~/server/kernel/api");
        await startPass(tx, calendarInvalidatePass, {
          key: task.origin,
          cursor: { origin: task.origin, reason: task.reason },
        });
        continue;
      }
      await enqueueJob(tx, {
        key: backgroundTaskJobKey(task),
        kind: task.kind,
        input: z.json().parse(JSON.parse(JSON.stringify(task))),
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
