import type { TelemetryMessageV1 } from "@cubby/schemas/telemetry";
import { describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import { emitTelemetry, type TelemetryPorts } from "./telemetry";

const db = new Database(() => {
  throw new Error("Telemetry unit ports do not resolve a database runtime");
});
const event: TelemetryMessageV1 = {
  version: 1,
  queueType: "telemetry",
  eventId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
  occurredAt: "2026-08-02T16:00:00.000Z",
  release: "abcdef0",
  type: "ai_usage",
  feature: "recipe-flow",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  operation: "generate",
  inputTokens: 10,
  outputTokens: 20,
  durationMs: 42,
  cacheStatus: "miss",
  entityType: null,
  entityId: null,
  batchId: null,
};

describe("emitTelemetry", () => {
  it("persists inline without a Worker queue binding", async () => {
    const persisted: TelemetryMessageV1[][] = [];
    const ports = {
      getTelemetryQueue: () => undefined,
      getExecutionCtx: () => undefined,
      persistTelemetryMessages: async (_db, messages) => {
        persisted.push([...messages]);
      },
    } satisfies TelemetryPorts;

    await emitTelemetry(db, event, ports);
    expect(persisted).toEqual([[event]]);
  });
});
