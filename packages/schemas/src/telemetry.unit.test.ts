import { describe, expect, it } from "vitest";
import {
  mcpToolCallTelemetrySchema,
  telemetryMessageV1Schema,
} from "./telemetry";

const mcpEvent = {
  version: 1 as const,
  queueType: "telemetry" as const,
  eventId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
  occurredAt: "2026-08-02T16:00:00.000Z",
  release: "abcdef0",
  type: "mcp_tool_call" as const,
  toolName: "search_products",
  outcome: "success" as const,
  registeredAtCall: true,
  surface: "external_mcp" as const,
  userId: "user_1",
  clientId: "oauth-client-1",
};

describe("telemetryMessageV1Schema", () => {
  it("dispatches the strict versioned union", () => {
    const parsed = telemetryMessageV1Schema.parse(mcpEvent);

    expect(parsed.type).toBe("mcp_tool_call");
  });

  it.each(["arguments", "output", "errorText", "sessionId"])(
    "rejects privacy field %s",
    (field) => {
      expect(
        mcpToolCallTelemetrySchema.safeParse({
          ...mcpEvent,
          [field]: "must not enter telemetry",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects a message missing or mismatching queueType", () => {
    // `queueType` is what makes the message format merge-ready: a consumer
    // reading a single merged queue would route on it instead of `batch.queue`.
    const { queueType: _dropped, ...withoutQueueType } = mcpEvent;
    expect(telemetryMessageV1Schema.safeParse(withoutQueueType).success).toBe(
      false,
    );
    expect(
      telemetryMessageV1Schema.safeParse({
        ...mcpEvent,
        queueType: "background",
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported versions and event types", () => {
    expect(
      telemetryMessageV1Schema.safeParse({ ...mcpEvent, version: 2 }).success,
    ).toBe(false);
    expect(
      telemetryMessageV1Schema.safeParse({ ...mcpEvent, type: "trace" })
        .success,
    ).toBe(false);
  });

  it("accepts a message with no entity — in-flight queue messages minted before this field existed have none", () => {
    // `mcpEvent` above already carries no `entity` key and parses; this test
    // pins that down explicitly so a future edit can't silently make it
    // required (which would reject those in-flight replays).
    const result = mcpToolCallTelemetrySchema.safeParse(mcpEvent);
    expect(result.success).toBe(true);
    expect(result.success && result.data.entity).toBeUndefined();
  });

  it("accepts a valid entity and rejects a value outside the entity enum", () => {
    expect(
      mcpToolCallTelemetrySchema.safeParse({ ...mcpEvent, entity: "product" })
        .success,
    ).toBe(true);
    expect(
      mcpToolCallTelemetrySchema.safeParse({
        ...mcpEvent,
        entity: "not-a-real-entity",
      }).success,
    ).toBe(false);
  });
});
