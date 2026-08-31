import type { TelemetryMessageV1 } from "@cubby/schemas/telemetry";
import { describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import {
  processTelemetryQueueBatch,
  type TelemetryQueuePorts,
} from "./telemetry-queue";

const db = new Database(() => {
  throw new Error(
    "Telemetry-queue unit ports do not resolve a database runtime",
  );
});
const event: TelemetryMessageV1 = {
  version: 1,
  queueType: "telemetry",
  eventId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
  occurredAt: "2026-08-02T16:00:00.000Z",
  release: "abcdef0",
  type: "mcp_tool_call",
  toolName: "search_products",
  outcome: "success",
  registeredAtCall: true,
  surface: "external_mcp",
  userId: "user_1",
  clientId: null,
};

describe("processTelemetryQueueBatch", () => {
  it("acknowledges a persisted valid message", async () => {
    let acknowledged = false;
    const ports = {
      persistTelemetryMessages: async () => undefined,
    } satisfies TelemetryQueuePorts;
    await processTelemetryQueueBatch(
      db,
      {
        queue: "cubby-telemetry",
        messages: [
          {
            body: event,
            ack: () => {
              acknowledged = true;
            },
            retry: () => undefined,
          },
        ],
      },
      ports,
    );
    expect(acknowledged).toBe(true);
  });
});
