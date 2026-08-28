import { telemetryMessageV1Schema } from "@cubby/schemas/telemetry";

import type { Database } from "~/server/db";
import { persistTelemetryMessages } from "~/server/repo/telemetry";

import type { TelemetryQueueBatch } from "./telemetry-queue-types";

export interface TelemetryQueuePorts {
  readonly persistTelemetryMessages: typeof persistTelemetryMessages;
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
      console.warn("[telemetry] dropped invalid queue message", {
        issues: parsed.error.issues,
      });
      message.ack();
      continue;
    }
    valid.push({ event: parsed.data, message });
  }

  if (valid.length === 0) return;
  try {
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
