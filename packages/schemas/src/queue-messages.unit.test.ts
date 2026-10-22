import { describe, expect, expectTypeOf, it } from "vitest";
import { backgroundTaskSchema } from "./background-tasks";
import { backgroundTaskMessageSchema } from "./queue-messages";
import { telemetryMessageV1Schema } from "./telemetry";
import { testEntityId } from "./test-support/identifiers";

const requestedAt = "2026-09-12T12:00:00.000Z";

describe("background task messages", () => {
  it("transports only a strict version-3 wake while admission keeps branded inputs", () => {
    const entityId = testEntityId("product", "embedding");
    const parsed = backgroundTaskSchema.parse({
      kind: "entity-embedding.refresh",
      requestedAt,
      entityKind: "product",
      entityId,
    });
    if (parsed.kind !== "entity-embedding.refresh")
      throw new Error("wrong kind");
    expectTypeOf(parsed.ref.id).toMatchTypeOf<string>();
    expect(parsed.ref).toEqual({ entity: "product", id: entityId });
    expect(
      backgroundTaskMessageSchema.parse({
        version: 3,
        queueType: "background",
      }),
    ).toEqual({ version: 3, queueType: "background" });
    expect(
      backgroundTaskMessageSchema.safeParse({
        version: 3,
        queueType: "background",
        task: parsed,
      }).success,
    ).toBe(false);
    expect(
      backgroundTaskMessageSchema.safeParse({
        version: 2,
        queueType: "background",
        task: parsed,
      }).success,
    ).toBe(false);
  });

  it("rejects retired execution admissions instead of silently accepting work", () => {
    for (const kind of [
      "workflow.continue",
      "derived-refresh.wakeup",
      "recipe-totals.recompute",
      "maintenance.recover",
    ]) {
      expect(
        backgroundTaskSchema.safeParse({ kind, requestedAt }).success,
      ).toBe(false);
    }
  });

  it("leaves telemetry on its version-1 envelope", () => {
    expect(
      telemetryMessageV1Schema.safeParse({
        version: 2,
        queueType: "telemetry",
        eventId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
        occurredAt: requestedAt,
        release: "abc",
        type: "mcp_tool_call",
        toolName: "x",
        outcome: "success",
        registeredAtCall: true,
        surface: "external_mcp",
        userId: "u",
        clientId: "c",
      }).success,
    ).toBe(false);
  });
});
