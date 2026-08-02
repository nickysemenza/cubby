import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type McpToolCallTelemetry,
  mcpToolCallTelemetrySchema,
  type TelemetryMessageV1,
  telemetryMessageV1Schema,
} from "./telemetry";

const mcpEvent = {
  version: 1 as const,
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
  it("dispatches the strict versioned union and infers its types", () => {
    const parsed = telemetryMessageV1Schema.parse(mcpEvent);

    expect(parsed.type).toBe("mcp_tool_call");
    expectTypeOf(parsed).toMatchTypeOf<TelemetryMessageV1>();
    expectTypeOf(
      mcpToolCallTelemetrySchema.parse(mcpEvent),
    ).toEqualTypeOf<McpToolCallTelemetry>();
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

  it("rejects unsupported versions and event types", () => {
    expect(
      telemetryMessageV1Schema.safeParse({ ...mcpEvent, version: 2 }).success,
    ).toBe(false);
    expect(
      telemetryMessageV1Schema.safeParse({ ...mcpEvent, type: "trace" })
        .success,
    ).toBe(false);
  });
});
