import {
  telemetryMessageV1Schema,
  legacyAiUsageTelemetrySchema,
} from "@cubby/schemas/telemetry";
import { createLogger } from "@cubby/worker-tracing";

import { snapshotAiUsagePrice } from "~/server/ai/pricing";
import type { Database } from "~/server/db";
import {
  prepareLegacyAiUsageTelemetry,
  persistTelemetryMessages,
} from "~/server/repo/telemetry";

import type { TelemetryQueueBatch } from "./telemetry-queue-types";

const log = createLogger("telemetry");

export interface TelemetryQueuePorts {
  readonly persistTelemetryMessages: typeof persistTelemetryMessages;
  readonly snapshot?: typeof snapshotAiUsagePrice;
}

const productionTelemetryQueuePorts: TelemetryQueuePorts = {
  persistTelemetryMessages,
};

export async function processTelemetryQueueBatch(
  db: Database,
  batch: TelemetryQueueBatch,
  ports: TelemetryQueuePorts = productionTelemetryQueuePorts,
): Promise<void> {
  const valid: Array<{
    event: ReturnType<typeof telemetryMessageV1Schema.parse>;
    message: TelemetryQueueBatch["messages"][number];
  }> = [];

  for (const message of batch.messages) {
    const parsed = telemetryMessageV1Schema.safeParse(message.body);
    if (!parsed.success) {
      log.warn("dropped invalid queue message", {
        issues: parsed.error.issues,
      });
      message.ack();
      continue;
    }
    valid.push({ event: parsed.data, message });
  }

  if (valid.length === 0) return;
  try {
    for (const entry of valid) {
      const legacy = legacyAiUsageTelemetrySchema.safeParse(entry.message.body);
      if (legacy.success)
        entry.event = await prepareLegacyAiUsageTelemetry(
          legacy.data,
          ports.snapshot ?? snapshotAiUsagePrice,
        );
    }
    await ports.persistTelemetryMessages(
      db,
      valid.map(({ event }) => event),
    );
    for (const { message } of valid) message.ack();
  } catch (error) {
    for (const { message } of valid) message.retry();
    throw error;
  }
}
