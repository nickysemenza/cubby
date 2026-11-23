import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";
import { sql } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";

import type { BackgroundQueueBatch } from "../background-queue-types";
import {
  clearDeliveredWakes,
  collectDeliveryWakes,
  offerWake,
  wakeKernel,
} from "./publish";

export interface BackgroundQueueConsumerPorts {
  readonly captureException: (error: UnparsedError) => void;
  readonly afterSuccess?: () => Promise<void>;
}

const BUDGET_MS = 20_000;
/**
 * A drained runner that still sees due work could not claim it, or another
 * writer made it due and sent its own wake; either way an immediate permit
 * would only spin.
 */
const DUE_UNCLAIMED_RETRY_MS = 15_000;

/**
 * The kernel rows own retries. A permit runs the kernel, then offers the
 * global next deadline through the single pending wake (`offerWake`).
 */
export async function handleBackgroundQueueBatch(
  db: Database,
  batch: BackgroundQueueBatch,
  ports: BackgroundQueueConsumerPorts,
) {
  const { runProductionKernel } = await import("~/server/kernel/api");
  const { kernelNextSql } = await import("~/server/kernel/runner");
  const { productionKernel } = await import("~/server/kernel/kernel");
  const { repositoryQueries } =
    await import("~/server/db/repository-access.boundary");
  try {
    const bodies = batch.messages.map(
      (message) => backgroundTaskMessageSchema.safeParse(message.body).data,
    );
    await clearDeliveredWakes(
      db,
      bodies.flatMap((body) => (body?.at ? [body.at] : [])),
    );
    if (bodies.some((body) => body?.ring))
      await (
        await import("~/server/domains/image-processing/repo/image-processing-ring")
      ).ringDueDeviceWork(db);
    const { result, future } = await collectDeliveryWakes(async () => {
      const { ran, exhausted } = await runProductionKernel(db, {
        budgetMs: BUDGET_MS,
      });
      let alertAt: Date | null;
      try {
        const { dispatchBackgroundAlerts } =
          await import("~/server/generic/push/repo/delivery");
        alertAt = await dispatchBackgroundAlerts(db);
      } catch (error) {
        ports.captureException(error);
        alertAt = new Date(Date.now() + 60_000);
      }
      return { ran, exhausted, alertAt };
    });
    const kernel = await repositoryQueries(db).execute<{ at: string | null }>(
      sql`SELECT to_char((${kernelNextSql((await productionKernel()).registry)}), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
    );
    const kernelAt = kernel.rows[0]?.at;
    const next = [
      kernelAt ? new Date(kernelAt) : null,
      result.alertAt,
      future,
    ].reduce<Date | null>(
      (earliest, at) => (at && (!earliest || at < earliest) ? at : earliest),
      null,
    );
    if (next && next.getTime() > Date.now())
      await offerWake(db, next, "kernel.next");
    else if (next && result.exhausted)
      await wakeKernel({ source: "kernel.continuation" });
    else if (next)
      await offerWake(
        db,
        new Date(Date.now() + DUE_UNCLAIMED_RETRY_MS),
        "kernel.due-unclaimed",
      );
    for (const message of batch.messages) message.ack();
    if (result.ran) await ports.afterSuccess?.();
  } catch (error) {
    ports.captureException(error);
    for (const message of batch.messages) message.retry({ delaySeconds: 30 });
  }
}
