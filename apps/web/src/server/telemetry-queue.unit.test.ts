import type { TelemetryMessageV1 } from "@cubby/schemas/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const persistTelemetryMessages = vi.fn();
vi.mock("~/server/repo/telemetry", () => ({ persistTelemetryMessages }));

const { processTelemetryQueueBatch } = await import("./telemetry-queue");

const validEvent: TelemetryMessageV1 = {
  version: 1,
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

function delivered(body: unknown) {
  return { body, ack: vi.fn(), retry: vi.fn() };
}

describe("processTelemetryQueueBatch", () => {
  beforeEach(() => persistTelemetryMessages.mockReset());

  it("acknowledges malformed and unsupported messages individually", async () => {
    const malformed = delivered({ ...validEvent, arguments: { secret: true } });
    const unsupported = delivered({ ...validEvent, version: 2 });

    await processTelemetryQueueBatch({} as never, {
      queue: "cubby-telemetry",
      messages: [malformed, unsupported],
    });

    expect(malformed.ack).toHaveBeenCalledOnce();
    expect(unsupported.ack).toHaveBeenCalledOnce();
    expect(malformed.retry).not.toHaveBeenCalled();
    expect(persistTelemetryMessages).not.toHaveBeenCalled();
  });

  it("acks a persisted batch and retries valid messages on database failure", async () => {
    const success = delivered(validEvent);
    persistTelemetryMessages.mockResolvedValueOnce(undefined);
    await processTelemetryQueueBatch({} as never, {
      queue: "cubby-telemetry",
      messages: [success],
    });
    expect(success.ack).toHaveBeenCalledOnce();

    const failed = delivered(validEvent);
    persistTelemetryMessages.mockRejectedValueOnce(new Error("database down"));
    await expect(
      processTelemetryQueueBatch({} as never, {
        queue: "cubby-telemetry",
        messages: [failed],
      }),
    ).rejects.toThrow("database down");
    expect(failed.retry).toHaveBeenCalledOnce();
    expect(failed.ack).not.toHaveBeenCalled();
  });
});
