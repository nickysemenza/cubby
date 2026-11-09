import { backgroundTaskMessageSchema } from "@cubby/schemas/queue-messages";

import type { UnparsedError } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import {
  runPermit,
  type PermitRuntime,
} from "~/server/generic/jobs/service/permits";

import type { BackgroundQueueBatch } from "../background-queue-types";

export interface BackgroundQueueConsumerPorts {
  /** `unit` names the background unit whose page failed, for grouping. */
  readonly captureException: (error: UnparsedError, unit?: string) => void;
  readonly afterSuccess?: () => Promise<void>;
  /** The permit runtime; production handlers and drains by default. */
  readonly runtime?: (db: Database) => PermitRuntime;
}

/**
 * Each delivery is one permit (`maxBatchSize` 1). The unit it runs owns its own
 * retries in Postgres, so a permit acknowledges whatever the unit's outcome;
 * only a failure before or around selection (the database unreachable, say)
 * retries delivery. An unreadable envelope is still a permit.
 */
export async function handleBackgroundQueueBatch(
  db: Database,
  batch: BackgroundQueueBatch,
  ports: BackgroundQueueConsumerPorts,
) {
  for (const message of batch.messages) {
    try {
      if (backgroundTaskMessageSchema.safeParse(message.body).data?.ring)
        await (
          await import("~/server/domains/image-processing/repo/image-processing-ring")
        ).ringDueDeviceWork(db);
      const runtime =
        ports.runtime?.(db) ??
        (await import("~/server/workflows/jobs")).productionPermitRuntime(
          db,
          ports.captureException,
        );
      const unit = await runPermit(runtime);
      message.ack();
      if (unit) await ports.afterSuccess?.();
    } catch (error) {
      ports.captureException(error);
      message.retry({ delaySeconds: 30 });
    }
  }
}
