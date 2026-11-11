import * as Sentry from "@sentry/cloudflare";
import { z } from "zod";

import { TELEMETRY_SCHEMA_VERSION } from "~/lib/http-cache";
import { withCfEnv } from "~/server/cf-env";
import { db, withInvocationDb } from "~/server/db";
import { recordDatabaseWrite } from "~/server/db/freshness/client";
import {
  annotateActiveSpan,
  withInvocationTrace,
} from "~/server/observability/tracing";
import { QUEUE_NAMES } from "~/server/worker-identity";
import type { BackgroundQueueBatch } from "~/server/workflows/background-queue-types";

type QueueDelivery = Omit<BackgroundQueueBatch, "queue"> & {
  readonly queue: string;
};

export const FORWARDED_QUEUE_PATH = "/__internal/background-queue";
const outcomesSchema = z.array(
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("ack") }),
    z.object({
      action: z.literal("retry"),
      delaySeconds: z.number().optional(),
    }),
  ]),
);

async function forwardBackgroundQueue(batch: QueueDelivery, env: Env) {
  const response = await env.BACKGROUND_WORKER.fetch(
    `https://internal${FORWARDED_QUEUE_PATH}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch.messages.map((message) => message.body)),
    },
  );
  annotateActiveSpan({
    "cloudflare.forwarded_placement":
      response.headers.get("cf-placement") ?? undefined,
  });
  if (!response.ok)
    throw new Error(`Background forwarding failed: ${response.status}`);
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
}

export async function handleForwardedQueue(request: Request, env: Env) {
  const bodies = z.array(z.unknown()).parse(await request.json());
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
  await runQueueInvocation(
    { queue: QUEUE_NAMES.background, messages },
    env,
    true,
    request.headers.get("cf-placement") ?? undefined,
  );
  return Response.json(outcomes);
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
  forwarded: boolean,
  placement?: string,
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
          !forwarded &&
          batch.queue === QUEUE_NAMES.background &&
          env.BACKGROUND_WORKER
        ) {
          await forwardBackgroundQueue(batch, env);
          return;
        }

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
        "cubby.workload": forwarded ? "queue.forwarded" : "queue",
        "cloudflare.placement": placement,
        "messaging.destination.name": batch.queue,
        "messaging.batch.message_count": batch.messages.length,
        "service.version": env.CF_VERSION_METADATA.id,
        "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      },
    ),
  );
}
