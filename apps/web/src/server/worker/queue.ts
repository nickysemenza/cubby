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

// Each background delivery is one permit to run one unit; the unit's rows own
// its retries, including when a permit envelope is unreadable.
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
        "cubby.workload": "queue",
        "messaging.destination.name": batch.queue,
        "messaging.batch.message_count": batch.messages.length,
        "service.version": env.CF_VERSION_METADATA.id,
        "cubby.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
      },
    ),
  );
}
