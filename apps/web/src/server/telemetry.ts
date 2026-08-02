import {
  type TelemetryMessageV1,
  telemetryMessageV1Schema,
} from "@cubby/schemas/telemetry";
import { getTelemetryQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { persistTelemetryMessages } from "~/server/repo/telemetry";

/**
 * Publish one telemetry event. Queue failures are deliberately non-fatal; in
 * Node development, where no binding exists, persist inline for useful parity.
 */
export async function emitTelemetry(
  db: Database,
  input: TelemetryMessageV1,
): Promise<void> {
  const event = telemetryMessageV1Schema.parse(input);
  const queue = getTelemetryQueue();
  if (!queue) {
    await persistTelemetryMessages(db, [event]);
    return;
  }

  try {
    await queue.send(event);
  } catch (error) {
    console.error("[telemetry] failed to enqueue event", {
      type: event.type,
      eventId: event.eventId,
      error,
    });
  }
}
