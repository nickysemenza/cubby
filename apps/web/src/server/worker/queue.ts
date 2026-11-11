import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import { TELEMETRY_SCHEMA_VERSION } from "~/lib/http-cache";
import { withCfEnv } from "~/server/cf-env";
import { db, withInvocationDb } from "~/server/db";
import { recordDatabaseWrite } from "~/server/db/freshness/client";
import { withInvocationTrace } from "~/server/observability/tracing";
import { QUEUE_NAMES } from "~/server/worker-identity";
import type { BackgroundQueueBatch } from "~/server/workflows/background-queue-types";

import { forwardToPlaced } from "./placed";

type QueueDelivery = Omit<BackgroundQueueBatch, "queue"> & {
  readonly queue: string;
};

const outcomesSchema = z.array(
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("ack") }),
    z.object({
      action: z.literal("retry"),
      delaySeconds: z.number().optional(),
    }),
  ]),
);

// The placed callee settles each message; the caller applies the outcomes.
async function forwardBackgroundQueue(batch: QueueDelivery, env: Env) {
  const response = await forwardToPlaced(env, {
    event: "queue",
    queue: batch.queue,
    bodies: batch.messages.map((message) => message.body),
  });
  if (!response) return false;
  const outcomes = outcomesSchema.parse(await response.json());
  if (outcomes.length !== batch.messages.length)
    throw new Error("Background forwarding returned an invalid outcome count");
  outcomes.forEach((outcome, index) => {
    const message = batch.messages[index]!;
    if (outcome.action === "ack") message.ack();
    else
      message.retry(
        outcome.delaySeconds === undefined
          ? undefined
          : { delaySeconds: outcome.delaySeconds },
      );
  });
  return true;
}

/** The placed side of {@link forwardBackgroundQueue}. */
export async function runPlacedQueue(
  queue: string,
  bodies: readonly unknown[],
  env: Env,
) {
  const outcomes: z.infer<typeof outcomesSchema> = [];
  const messages = bodies.map((body, index) => ({
    body,
    ack: () => {
      outcomes[index] ??= { action: "ack" };
    },
    retry: (options?: { delaySeconds: number }) => {
      outcomes[index] ??= {
        action: "retry",
        delaySeconds: options?.delaySeconds,
      };
    },
  }));
  await runQueueInvocation({ queue, messages }, env, true);
  // A delivery that returns without settling a message acknowledges it.
  return Response.json(
    bodies.map((_, index) => outcomes[index] ?? { action: "ack" }),
  );
}

// Each background delivery is one permit to run one unit; the unit's rows own
// its retries, including when a permit envelope is unreadable.
export async function handleQueueInvocation(
  batch: QueueDelivery,
  env: Env,
  _ctx: { waitUntil(promise: Promise<unknown>): void },
) {
  return runQueueInvocation(batch, env, false);
}

async function runQueueInvocation(
  batch: QueueDelivery,
  env: Env,
  placed: boolean,
) {
  return withCfEnv(env, () =>
    withInvocationTrace(
      "cf.queue",
      async () => {
        if (
          batch.queue !== QUEUE_NAMES.telemetry &&
          batch.queue !== QUEUE_NAMES.background
        )
          throw new Error(`Unexpected queue: ${batch.queue}`);
        if (
          !placed &&
          batch.queue === QUEUE_NAMES.background &&
          (await forwardBackgroundQueue(batch, env))
        )
          return;

        // One shared two-socket pool per invocation, closed when it finishes
        // (docs/infrastructure.md#background-connection-budget).
        await withInvocationDb(
          env.HYPERDRIVE_BACKGROUND.connectionString,
          async () => {
            if (batch.queue === QUEUE_NAMES.telemetry) {
              const { processTelemetryQueueBatch } =
                await import("~/server/observability/telemetry-queue");
              await processTelemetryQueueBatch(db, {
                ...batch,
                queue: QUEUE_NAMES.telemetry,
              });
              return;
            }

            // Defer domain consumer evaluation until this transport is selected.
            const { handleBackgroundQueueBatch } =
              await import("~/server/workflows/background-tasks/consume");
            await handleBackgroundQueueBatch(
              db,
              { ...batch, queue: QUEUE_NAMES.background },
              {
                captureException: (error, unit) => {
                  Sentry.withScope((scope) => {
                    if (unit) scope.setTag("cubby.background.unit", unit);
                    Sentry.captureException(error);
                  });
                },
                afterSuccess: async () => {
                  await recordDatabaseWrite("background-job");
                },
              },
            );
          },
        );
      },
      {
        "cubby.workload": placed ? "queue.placed" : "queue",
        "messaging.destination.name": batch.queue,
        "messaging.batch.message_count": batch.messages.length,
        "service.version": env.CF_VERSION_METADATA.id,
        "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      },
    ),
  );
}
