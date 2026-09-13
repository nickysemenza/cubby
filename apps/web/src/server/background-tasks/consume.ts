import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";

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
 * Deliver one message. The transport outcome is decided here; the domain
 * outcome comes from the task handler.
 *
 * - succeeded / skipped → ack. A freshness no-op is a success.
 * - the handler throws → retry, so the queue's own bounded retries apply.
 * - the body does not parse → retry as well. It will not become readable, but
 *   acking would make an unreadable message look like completed work; after
 *   the retry budget the queue drops it, and every attempt was reported.
 */
async function processBackgroundQueueMessage(
  db: Database,
  message: BackgroundQueueDeliveredMessage,
  ports: BackgroundQueueConsumerPorts,
): Promise<BackgroundQueueMessageOutcome> {
  const parsed = backgroundTaskMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    const error = new Error(
      `Unreadable background queue message: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
    console.error("[background-tasks] unreadable message", {
      issues: parsed.error.issues,
    });
    ports.captureException(error);
    message.retry();
    return "unreadable";
  }

  const { task } = parsed.data;
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
 * Consume one delivered batch serially. A message's failure never touches its
 * siblings: each is acked or retried on its own, and the success hook runs at
 * most once per invocation.
 */
export async function handleBackgroundQueueBatch(
  db: Database,
  batch: BackgroundQueueBatch,
  ports: BackgroundQueueConsumerPorts,
): Promise<BackgroundQueueMessageOutcome[]> {
  const outcomes: BackgroundQueueMessageOutcome[] = [];
  for (const message of batch.messages) {
    outcomes.push(await processBackgroundQueueMessage(db, message, ports));
  }
  if (ports.afterSuccess && outcomes.includes("succeeded")) {
    await ports.afterSuccess();
  }
  return outcomes;
}
