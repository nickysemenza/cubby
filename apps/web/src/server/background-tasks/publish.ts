import {
  type BackgroundTaskInput,
  type BackgroundTaskReceipt,
  backgroundTaskSchema,
} from "@cubby/schemas/background-tasks";
import {
  BACKGROUND_TASK_MESSAGE_VERSION,
  type BackgroundTaskMessageInput,
} from "@cubby/schemas/queue-messages";
import * as Sentry from "@sentry/tanstackstart-react";

import type { UnparsedError } from "~/lib/error-utils";
import { getBackgroundQueue, getExecutionCtx } from "~/server/cf-env";
import type { Database } from "~/server/db";

import type { BackgroundQueueProducer } from "../background-queue-types";

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

async function runInline(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
): Promise<void> {
  // Deferred boundary: producer-side services never statically import the
  // handlers that import those same services.
  const { handleBackgroundTask } = await import("./handle");
  for (const task of tasks) {
    await handleBackgroundTask(db, backgroundTaskSchema.parse(task));
  }
}

/**
 * Hand a task list to the queue and return once it has been accepted.
 *
 * On Cloudflare the queue's acceptance is the durable handoff; there is no
 * execution row behind it. In plain Node development there is no queue, so
 * the same handler runs inline — same code, same freshness gates, no separate
 * retry engine.
 */
export async function publishBackgroundTasks(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<BackgroundTaskReceipt> {
  if (tasks.length === 0) return { transport: "queue", count: 0 };
  const queue = getBackgroundQueue();
  if (queue) {
    await sendToQueue(queue, tasks);
    console.log(
      `[background-tasks] published count=${tasks.length} source=${options.source}`,
    );
    return { transport: "queue", count: tasks.length };
  }
  await runInline(db, tasks);
  return { transport: "inline", count: tasks.length };
}

/**
 * Publish after a mutation without holding the response for it.
 *
 * The saved mutation is already committed; a failed publication is reported
 * (log + Sentry) and never implies a rollback. The stale marker on the source
 * row keeps the work discoverable — the Problems page's "Awaiting work" card
 * and the recipe/relatedness reads repair it. Without an execution context
 * (Node dev, queue consumers) the publication is simply awaited.
 */
export function publishInBackground(
  db: Database,
  tasks: readonly BackgroundTaskInput[],
  options: PublishOptions,
): Promise<void> {
  if (tasks.length === 0) return Promise.resolve();
  const publication = publishBackgroundTasks(db, tasks, options)
    .then(() => undefined)
    .catch((error: UnparsedError) => {
      console.error("[background-tasks] publication failed", {
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
) => Promise<{ transport: string; count: number }>;

export interface DeferredPublications {
  readonly publish: BackgroundTaskPublisher;
  /** Send everything collected so far; call once the transaction committed. */
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
      return { transport: "deferred", count: tasks.length };
    },
    flush: async (db) => {
      for (const { tasks, source } of pending.splice(0)) {
        await publishInBackground(db, tasks, { source });
      }
    },
  };
}
