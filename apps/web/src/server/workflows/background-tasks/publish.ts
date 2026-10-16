import {
  type BackgroundTaskInput,
  type BackgroundTaskReceipt,
} from "@cubby/schemas/background-tasks";
import {
  BACKGROUND_TASK_MESSAGE_VERSION,
  type BackgroundTaskMessageInput,
} from "@cubby/schemas/queue-messages";
import { createLogger } from "@cubby/worker-tracing";
import * as Sentry from "@sentry/tanstackstart-react";

import type { UnparsedError } from "~/lib/error-utils";
import { getBackgroundQueue, getExecutionCtx } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { runAfterCommit } from "~/server/db/helpers/core";

import type { BackgroundQueueProducer } from "../background-queue-types";

const log = createLogger("background-tasks");

/** Cloudflare accepts at most 100 messages per `sendBatch`. */
export const MAX_TASKS_PER_SEND = 100;
/** 128 KiB per message, minus room for the queue's own envelope. */
const MAX_MESSAGE_BYTES = 120_000;
/** 256 KiB per `sendBatch`, minus the same headroom. */
const MAX_SEND_BYTES = 240_000;

export interface PublishOptions {
  /** The code path publishing — for the log line, never for behavior. */
  readonly source: string;
}

const encoder = new TextEncoder();

const toMessage = (task: BackgroundTaskInput): BackgroundTaskMessageInput => ({
  version: BACKGROUND_TASK_MESSAGE_VERSION,
  queueType: "background",
  task,
});

/**
 * Slice a task list into `sendBatch` calls bounded by both count and the
 * serialized size of the bodies. Exported for the unit test only.
 */
export function planSendBatches(
  tasks: readonly BackgroundTaskInput[],
  limits: { maxTasks: number; maxMessageBytes: number; maxSendBytes: number },
): BackgroundTaskMessageInput[][] {
  const batches: BackgroundTaskMessageInput[][] = [];
  let current: BackgroundTaskMessageInput[] = [];
  let currentBytes = 0;
  for (const task of tasks) {
    const message = toMessage(task);
    const bytes = encoder.encode(JSON.stringify(message)).byteLength;
    if (bytes > limits.maxMessageBytes) {
      throw new Error(
        `Background task ${task.kind} serializes to ${bytes} bytes, above the ${limits.maxMessageBytes}-byte message limit`,
      );
    }
    if (
      current.length > 0 &&
      (current.length >= limits.maxTasks ||
        currentBytes + bytes > limits.maxSendBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(message);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function sendToQueue(
  queue: BackgroundQueueProducer,
  tasks: readonly BackgroundTaskInput[],
): Promise<void> {
  for (const batch of planSendBatches(tasks, {
    maxTasks: MAX_TASKS_PER_SEND,
    maxMessageBytes: MAX_MESSAGE_BYTES,
    maxSendBytes: MAX_SEND_BYTES,
  })) {
    await queue.sendBatch(batch.map((body) => ({ body })));
  }
}

/** Queue acceptance is the handoff; Node callers must install an explicit producer. */
export async function publishBackgroundTasks(
  _db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<BackgroundTaskReceipt> {
  if (tasks.length === 0) return { transport: "queue", count: 0 };
  const queue = requireBackgroundQueue(options.source);
  await sendToQueue(queue, tasks);
  log.info(`published count=${tasks.length} source=${options.source}`);
  return { transport: "queue", count: tasks.length };
}

function requireBackgroundQueue(source: string): BackgroundQueueProducer {
  const queue = getBackgroundQueue();
  if (!queue)
    throw new Error(
      `BACKGROUND_QUEUE binding is required to publish background tasks (source=${source}); Node callers must configure an explicit queue producer`,
    );
  return queue;
}

/** Enqueue from a caller without a Database; missing bindings and failed sends reject. */
export async function enqueueBackgroundTask(
  task: BackgroundTaskInput,
  options: PublishOptions,
): Promise<boolean> {
  await sendToQueue(requireBackgroundQueue(options.source), [task]);
  log.info(`published count=1 source=${options.source}`);
  return true;
}

/**
 * Publish after a mutation without holding the response for it.
 *
 * On a handle inside a `withTransaction` the publication waits for the
 * outermost commit (`runAfterCommit`), so no consumer reads the pre-write row
 * and a rollback publishes nothing. After the commit a failed publication is
 * reported (log + Sentry) and never implies a rollback. The stale marker on
 * the source row keeps the work discoverable — the Problems page's "Awaiting
 * work" card and the recipe/relatedness reads repair it. Without an execution
 * context (Node dev, queue consumers) the publication is simply awaited.
 */
export function publishInBackground(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<void> {
  if (tasks.length === 0) return Promise.resolve();
  return runAfterCommit(db, (committedDb) =>
    publishCommitted(committedDb, tasks, options),
  );
}

function publishCommitted(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<void> {
  const publication = publishBackgroundTasks(db, tasks, options)
    .then(() => undefined)
    .catch((error: UnparsedError) => {
      log.error("publication failed", {
        source: options.source,
        count: tasks.length,
        error,
      });
      Sentry.captureException(error);
    });
  const ctx = getExecutionCtx();
  if (ctx) {
    ctx.waitUntil(publication);
    return Promise.resolve();
  }
  return publication;
}

/**
 * A publish function a service can be handed instead of calling
 * {@link publishBackgroundTasks} directly — the seam a write transaction uses
 * to hold its publications back until after commit.
 */
export type BackgroundTaskPublisher = (
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
) => Promise<BackgroundTaskReceipt | void>;

export interface DeferredPublications {
  readonly publish: BackgroundTaskPublisher;
  /**
   * Send everything collected so far; call once the transaction committed.
   * On a handle still inside an outer transaction this defers again, to the
   * outer commit ({@link publishInBackground}).
   */
  flush(db: Database): Promise<void>;
}

/**
 * Publications made inside a write transaction must go out after it commits:
 * a consumer that ran before the commit would read the old row, skip on its
 * freshness gate, and leave the stale marker with no wakeup behind it. The
 * flush is best-effort ({@link publishInBackground}) — the stale marker is
 * already durable, so a failed publication is latency, not lost intent.
 */
export function deferPublications(): DeferredPublications {
  const pending: Array<{ tasks: BackgroundTaskInput[]; source: string }> = [];
  return {
    publish: async (_db, tasks, options) => {
      if (tasks.length > 0)
        pending.push({ tasks: [...tasks], source: options.source });
    },
    flush: async (db) => {
      for (const { tasks, source } of pending.splice(0)) {
        await publishInBackground(db, tasks, { source });
      }
    },
  };
}
