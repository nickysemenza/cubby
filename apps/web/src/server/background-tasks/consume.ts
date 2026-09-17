import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import type { SearchableEntityRef } from "@cubby/schemas/search";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { TraceNames, withTrace } from "~/server/tracing";

import type {
  BackgroundQueueBatch,
  BackgroundQueueDeliveredMessage,
} from "../background-queue-types";
import {
  type BackgroundTaskOutcome,
  type BackgroundTaskPorts,
  handleBackgroundTask,
  productionBackgroundTaskPorts,
} from "./handle";

/**
 * `captureException` has no default on purpose: a default no-op would make a
 * silent-alerting regression invisible, and importing the Sentry SDK here
 * would pull it into every test that touches this module. The caller owns it.
 */
export interface BackgroundQueueConsumerPorts {
  readonly captureException: (error: UnparsedError) => void;
  /** Runs once per invocation after any task succeeded. */
  readonly afterSuccess?: () => Promise<void>;
  readonly tasks?: BackgroundTaskPorts;
  /** The task executor; tests substitute a faithful fake to exercise transport outcomes. */
  readonly handleTask?: typeof handleBackgroundTask;
}

export type BackgroundQueueMessageOutcome =
  | BackgroundTaskOutcome
  | "unreadable"
  | "failed";

/**
 * Parse one delivered message body against the version-2 envelope. Shared by
 * the single-message path and the batch partitioner so "unreadable" means the
 * same thing — and gets the same retry, not an ack — in both.
 */
function parseBackgroundQueueMessage(
  body: unknown,
): { task: BackgroundTask } | { error: Error } {
  const parsed = backgroundTaskMessageSchema.safeParse(body);
  if (!parsed.success) {
    return {
      error: new Error(
        `Unreadable background queue message: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      ),
    };
  }
  return { task: parsed.data.task };
}

/**
 * Run one already-parsed task and translate its outcome into the message's
 * transport disposition.
 *
 * - succeeded / skipped → ack. A freshness no-op is a success.
 * - the handler throws → retry, so the queue's own bounded retries apply.
 */
async function runBackgroundTask(
  db: Database,
  message: BackgroundQueueDeliveredMessage,
  task: BackgroundTask,
  ports: BackgroundQueueConsumerPorts,
): Promise<BackgroundQueueMessageOutcome> {
  const t0 = performance.now();
  try {
    const outcome = await withTrace(
      TraceNames.job(task.kind),
      async (span) => {
        const result = await (ports.handleTask ?? handleBackgroundTask)(
          db,
          task,
          ports.tasks ?? productionBackgroundTaskPorts,
        );
        span.setAttribute("cubby.job.outcome", result);
        return result;
      },
      {
        "cubby.job.kind": task.kind,
        "cubby.job.requested_at": task.requestedAt,
      },
    );
    console.log(
      `[background-tasks] handled kind=${task.kind} outcome=${outcome} duration_ms=${Math.round(performance.now() - t0)}`,
    );
    message.ack();
    return outcome;
  } catch (error) {
    console.error(
      `[background-tasks] failed kind=${task.kind} duration_ms=${Math.round(performance.now() - t0)}`,
      error,
    );
    ports.captureException(error);
    message.retry();
    return "failed";
  }
}

/**
 * Run every `entity-embedding.refresh` message in the batch through one
 * provider embed + one Vectorize upsert, then translate each ref's own result
 * back into its message's ack/retry — the batching is an implementation
 * detail of the call, not a merge of per-message transport isolation.
 *
 * `refreshEntityEmbeddings` throwing (the provider or the vector store is
 * down) fails the whole group identically: every message retries and the
 * exception is captured once, the same shape as a single handler throwing in
 * {@link runBackgroundTask}. A per-ref `{ error }` inside a successful batch
 * call (one bad ref does not have to fail its siblings) is captured once per
 * distinct error object, since one provider/store failure is commonly shared
 * by many refs in the same batch.
 */
async function runEmbeddingRefreshGroup(
  db: Database,
  messages: readonly BackgroundQueueDeliveredMessage[],
  indices: readonly number[],
  refs: readonly SearchableEntityRef[],
  ports: BackgroundQueueConsumerPorts,
  outcomes: BackgroundQueueMessageOutcome[],
): Promise<void> {
  const kind = "entity-embedding.refresh";
  const t0 = performance.now();
  const { refreshEntityEmbeddings, embeddingRefreshKey } =
    await import("./embedding");
  try {
    const results = await withTrace(
      TraceNames.job(kind),
      () => refreshEntityEmbeddings(db, refs),
      { "cubby.job.kind": kind, "cubby.job.batch_size": indices.length },
    );
    console.log(
      `[background-tasks] handled kind=${kind} batch_size=${indices.length} duration_ms=${Math.round(performance.now() - t0)}`,
    );

    const capturedErrors = new Set<unknown>();
    for (const [position, index] of indices.entries()) {
      const message = messages[index];
      const ref = refs[position];
      if (!message || !ref) continue;
      const key = embeddingRefreshKey(ref);
      const result = results.get(key);
      if (!result) {
        // Every input ref is contracted to get exactly one entry; a missing
        // key means the batched call itself is broken, not a per-ref failure.
        const error = new Error(
          `[background-tasks] missing embedding refresh result for ${key}`,
        );
        console.error(error);
        ports.captureException(error);
        message.retry();
        outcomes[index] = "failed";
        continue;
      }
      if ("error" in result) {
        console.error(
          `[background-tasks] failed kind=${kind} entity=${key}`,
          result.error,
        );
        if (!capturedErrors.has(result.error)) {
          capturedErrors.add(result.error);
          ports.captureException(result.error);
        }
        message.retry();
        outcomes[index] = "failed";
        continue;
      }
      const { outcome } = result;
      if (outcome === "obsolete" || outcome === "unconfigured") {
        console.warn(`[background-tasks] embedding ${outcome} ${key}`);
      }
      message.ack();
      outcomes[index] = outcome === "written" ? "succeeded" : "skipped";
    }
  } catch (error) {
    console.error(
      `[background-tasks] failed kind=${kind} batch_size=${indices.length} duration_ms=${Math.round(performance.now() - t0)}`,
      error,
    );
    ports.captureException(error);
    for (const index of indices) {
      messages[index]?.retry();
      outcomes[index] = "failed";
    }
  }
}

/**
 * Consume one delivered batch. A message's failure never touches its
 * siblings: each is acked or retried on its own, and the success hook runs at
 * most once per invocation.
 *
 * `entity-embedding.refresh` messages are pulled into one batched call
 * ({@link runEmbeddingRefreshGroup}); every other kind still runs one message
 * at a time through {@link runBackgroundTask}, in original message order —
 * matching today's behavior exactly when the batch holds no embedding
 * messages, or exactly one of anything.
 */
export async function handleBackgroundQueueBatch(
  db: Database,
  batch: BackgroundQueueBatch,
  ports: BackgroundQueueConsumerPorts,
): Promise<BackgroundQueueMessageOutcome[]> {
  const outcomes: BackgroundQueueMessageOutcome[] = Array.from({
    length: batch.messages.length,
  });
  const embeddingIndices: number[] = [];
  const embeddingRefs: SearchableEntityRef[] = [];

  for (const [index, message] of batch.messages.entries()) {
    const parsed = parseBackgroundQueueMessage(message.body);
    if ("error" in parsed) {
      console.error("[background-tasks] unreadable message", parsed.error);
      ports.captureException(parsed.error);
      message.retry();
      outcomes[index] = "unreadable";
      continue;
    }
    const { task } = parsed;
    if (task.kind === "entity-embedding.refresh") {
      embeddingIndices.push(index);
      embeddingRefs.push({
        entityType: task.entityType,
        entityId: task.entityId,
      });
      continue;
    }
    outcomes[index] = await runBackgroundTask(db, message, task, ports);
  }

  if (embeddingIndices.length > 0) {
    await runEmbeddingRefreshGroup(
      db,
      batch.messages,
      embeddingIndices,
      embeddingRefs,
      ports,
      outcomes,
    );
  }

  if (ports.afterSuccess && outcomes.includes("succeeded")) {
    await ports.afterSuccess();
  }
  return outcomes;
}
