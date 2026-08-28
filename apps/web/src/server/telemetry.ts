import {
  type TelemetryMessageV1,
  telemetryMessageV1Schema,
} from "@cubby/schemas/telemetry";

import type { UnparsedError } from "~/lib/error-utils";
import { getExecutionCtx, getTelemetryQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { persistTelemetryMessages } from "~/server/repo/telemetry";

export interface TelemetryPorts {
  readonly getTelemetryQueue: typeof getTelemetryQueue;
  readonly getExecutionCtx: typeof getExecutionCtx;
  readonly persistTelemetryMessages: typeof persistTelemetryMessages;
}

const productionTelemetryPorts: TelemetryPorts = {
  getTelemetryQueue,
  getExecutionCtx,
  persistTelemetryMessages,
};

/**
 * Publish one telemetry event. Queue failures are deliberately non-fatal; in
 * Node development, where no binding exists, persist inline for useful parity.
 */
export async function emitTelemetry(
  db: Database,
  input: TelemetryMessageV1,
  ports: TelemetryPorts = productionTelemetryPorts,
): Promise<void> {
  const event = telemetryMessageV1Schema.parse(input);
  const queue = ports.getTelemetryQueue();
  if (!queue) {
    await ports.persistTelemetryMessages(db, [event]);
    return;
  }

  // Telemetry must not sit between a tool call and its result. Every MCP
  // tool call and every AI call emits one, so an awaited send serializes a
  // queue round trip into each of them — five tool calls in an agent turn paid
  // five. waitUntil keeps the send alive past the response instead.
  const delivered = queue.send(event).catch((error: UnparsedError) => {
    console.error("[telemetry] failed to enqueue event", {
      type: event.type,
      eventId: event.eventId,
      error,
    });
  });

  const ctx = ports.getExecutionCtx();
  // No context outside a CF request (queue/cron invocations, Node dev): an
  // un-awaited promise there has nothing keeping it alive, so pay the wait.
  if (!ctx) {
    await delivered;
    return;
  }
  ctx.waitUntil(delivered);
}
