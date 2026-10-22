import * as Sentry from "@sentry/cloudflare";

import { TELEMETRY_SCHEMA_VERSION } from "~/lib/http-cache";
import { withCfEnv } from "~/server/cf-env";
import { db, withInvocationDb } from "~/server/db";
import { recordDatabaseWrite } from "~/server/db/freshness/client";
import type { PurchaseAgentQueueBatch } from "~/server/domains/purchase-agent/service/environment";
import { withInvocationTrace } from "~/server/observability/tracing";
import { QUEUE_NAMES } from "~/server/worker-identity";

type QueueDelivery = Omit<PurchaseAgentQueueBatch, "queue"> & {
  readonly queue: string;
};

export async function handleQueueInvocation(
  batch: QueueDelivery,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
) {
  return withCfEnv(env, () =>
    withInvocationTrace(
      "cf.queue",
      async () => {
        if (batch.queue === QUEUE_NAMES.purchaseAgent) {
          // The agent's consumer holds no database client: each Run service it
          // calls opens its own (`server/domains/purchase-import/operations/agent-services`).
          const { purchaseAgentQueueEnvironment } =
            await import("~/server/domains/purchase-import/operations/agent-host");
          const { consumePurchaseAgentQueue } =
            await import("~/server/domains/purchase-agent/service/queue");
          await consumePurchaseAgentQueue(
            { ...batch, queue: QUEUE_NAMES.purchaseAgent },
            purchaseAgentQueueEnvironment(env, ctx),
          );
          return;
        }

        if (
          batch.queue !== QUEUE_NAMES.telemetry &&
          batch.queue !== QUEUE_NAMES.background
        )
          throw new Error(`Unexpected queue: ${batch.queue}`);

        // A task can launch independent maintenance transactions concurrently.
        // Lease separate clients and close the bounded pools after the batch.
        await withInvocationDb(env.HYPERDRIVE.connectionString, async () => {
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
        });
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
