import * as Sentry from "@sentry/cloudflare";

import { TELEMETRY_SCHEMA_VERSION } from "~/lib/http-cache";
import { withCfEnv } from "~/server/cf-env";
import { db, withInvocationDb } from "~/server/db";
import { recordDatabaseWrite } from "~/server/db/freshness/client";
import { withInvocationTrace } from "~/server/observability/tracing";
import { QUEUE_NAMES } from "~/server/worker-identity";
import type { BackgroundQueueBatch } from "~/server/workflows/background-queue-types";

type QueueDelivery = Omit<BackgroundQueueBatch, "queue"> & {
  readonly queue: string;
};

// Deliveries wake the durable Job drain and always acknowledge. Job owns
// retries, including when a wake envelope is unreadable.
export async function handleQueueInvocation(
  batch: QueueDelivery,
  env: Env,
  _ctx: { waitUntil(promise: Promise<unknown>): void },
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

        // A task can launch independent maintenance transactions concurrently.
        // Lease separate clients and close the bounded pools after the batch.
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
                captureException: (error) => {
                  Sentry.captureException(error);
                },
                // The calendar projection reads only meal/task rows
                // (`repo/calendar-caldav`), which no background task kind
                // writes — marking it dirty here scheduled a full re-projection
                // after every batch (~1,000 during one backfill).
                afterSuccess: async () => {
                  await recordDatabaseWrite("background-job");
                },
              },
            );
          },
        );
      },
      {
        "cubby.workload": "queue",
        "messaging.destination.name": batch.queue,
        "messaging.batch.message_count": batch.messages.length,
        "service.version": env.CF_VERSION_METADATA.id,
        "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      },
    ),
  );
}
