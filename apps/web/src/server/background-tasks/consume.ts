import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { entityRefKey } from "@cubby/schemas/entity";
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
  type EmbeddingRefreshResult,
  refreshEntityEmbeddings,
} from "./embedding";
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
  /**
   * The batched embedding refresh; tests substitute a faithful fake to
   * exercise per-ref written/error/throttled outcomes without touching the
   * provider or the vector store. Mirrors `handleTask` above.
   */
  readonly refreshEmbeddings?: typeof refreshEntityEmbeddings;
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
 * Only the batched call itself is guarded by `try`/`catch`: it is the one
 * failure mode shared by the whole group (the provider or the vector store is
 * down), so every message retries and the exception is captured once — the
 * same shape as a single handler throwing in {@link runBackgroundTask}. The
 * per-message disposition loop below runs unguarded, after that `try` returns
 * normally, so a message can never be acked and then retried by a later throw
 * in the same invocation. A per-ref `{ error }` inside a successful batch call
 * (one bad ref does not have to fail its siblings) is captured once per
 * distinct error object, since one provider/store failure is commonly shared
 * by many refs in the same batch.
 */
async function runEmbeddingRefreshGroup(
  db: Database,
  messages: readonly BackgroundQueueDeliveredMessage[],
  indices: readonly number[],
  refs: readonly SearchableEntityRef[],
  requestedAts: readonly string[],
  ports: BackgroundQueueConsumerPorts,
  outcomes: (BackgroundQueueMessageOutcome | undefined)[],
): Promise<void> {
  const kind = "entity-embedding.refresh";
  const t0 = performance.now();
  // Mirrors `runBackgroundTask`'s single-task `cubby.job.requested_at`, but
  // for a group of tasks: the earliest `requestedAt` is the one that has been
  // waiting longest, so it is the more useful lag signal for a batch.
  const requestedAt = requestedAts.reduce((min, current) =>
    current < min ? current : min,
  );

  await withTrace(
    TraceNames.job(kind),
    async () => {
      let results: Map<string, EmbeddingRefreshResult>;
      try {
        results = await (ports.refreshEmbeddings ?? refreshEntityEmbeddings)(
          db,
          refs,
          (ports.tasks ?? productionBackgroundTaskPorts).embedding,
        );
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
        return;
      }

      console.log(
        `[background-tasks] handled kind=${kind} batch_size=${indices.length} duration_ms=${Math.round(performance.now() - t0)}`,
      );

      const capturedErrors = new Set<unknown>();
      for (const [position, index] of indices.entries()) {
        const message = messages[index];
        const ref = refs[position];
        if (!message || !ref) continue;
        const key = entityRefKey(ref.entityType, ref.entityId);
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
          // An immediate redelivery after a 429 re-pays the embed call (the
          // provider was already charged for it) and burns through
          // `max_retries` in seconds; a delayed retry gives the rate limiter
          // time to recover before the next attempt.
          if (result.throttled) {
            message.retry({
              delaySeconds: 30 + Math.floor(Math.random() * 30),
            });
          } else {
            message.retry();
          }
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
    },
    {
      "cubby.job.kind": kind,
      "cubby.job.batch_size": indices.length,
      "cubby.job.requested_at": requestedAt,
    },
  );
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
  const outcomes: (BackgroundQueueMessageOutcome | undefined)[] = Array.from({
    length: batch.messages.length,
  });
  const embeddingIndices: number[] = [];
  const embeddingRefs: SearchableEntityRef[] = [];
  const embeddingRequestedAts: string[] = [];

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
      embeddingRequestedAts.push(task.requestedAt);
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
      embeddingRequestedAts,
      ports,
      outcomes,
    );
  }

  if (ports.afterSuccess && outcomes.includes("succeeded")) {
    await ports.afterSuccess();
  }

  // Every branch above sets exactly one outcome per message index; a hole
  // means some path was added that forgot to. Assert it here, once, instead
  // of typing `outcomes` as `BackgroundQueueMessageOutcome[]` up front and
  // lying to the type system about what `Array.from({ length })` actually
  // produces.
  return outcomes.map((outcome, index) => {
    if (outcome === undefined) {
      throw new Error(
        `[background-tasks] no disposition recorded for message index ${index}`,
      );
    }
    return outcome;
  });
}
