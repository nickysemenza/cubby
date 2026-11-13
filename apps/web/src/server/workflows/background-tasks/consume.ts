import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { sql } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";

import type { BackgroundQueueBatch } from "../background-queue-types";
import { wakeAt } from "./publish";

export interface BackgroundQueueConsumerPorts {
  readonly captureException: (error: UnparsedError) => void;
  readonly afterSuccess?: () => Promise<void>;
}

/** The kernel rows own retries. A permit only wakes them and schedules their next deadline. */
export async function handleBackgroundQueueBatch(
  db: Database,
  batch: BackgroundQueueBatch,
  ports: BackgroundQueueConsumerPorts,
) {
  const { runProductionKernel } = await import("~/server/kernel/api");
  const { kernelNextSql } = await import("~/server/kernel/runner");
  const { repositoryQueries } =
    await import("~/server/db/repository-access.boundary");
  try {
    const ring = batch.messages.some(
      (message) =>
        backgroundTaskMessageSchema.safeParse(message.body).data?.ring,
    );
    if (ring)
      await (
        await import("~/server/domains/image-processing/repo/image-processing-ring")
      ).ringDueDeviceWork(db);
    const ran = await runProductionKernel(db, { budgetMs: 20_000 });
    const result = await repositoryQueries(db).execute<{ at: string | null }>(
      sql`SELECT to_char((${kernelNextSql()}), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
    );
    const at = result.rows[0]?.at;
    if (at) await wakeAt(new Date(at), { source: "kernel.successor" });
    for (const message of batch.messages) message.ack();
    if (ran) await ports.afterSuccess?.();
  } catch (error) {
    ports.captureException(error);
    for (const message of batch.messages) message.retry({ delaySeconds: 30 });
  }
}
