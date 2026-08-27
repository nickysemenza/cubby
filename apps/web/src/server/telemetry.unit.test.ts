import type { TelemetryMessageV1 } from "@cubby/schemas/telemetry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTelemetryQueue = vi.fn();
const getExecutionCtx = vi.fn();
const persistTelemetryMessages = vi.fn();
vi.mock("~/server/cf-env", () => ({ getTelemetryQueue, getExecutionCtx }));
vi.mock("~/server/repo/telemetry", () => ({ persistTelemetryMessages }));

const { emitTelemetry } = await import("./telemetry");

const event: TelemetryMessageV1 = {
  version: 1,
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
  beforeEach(() => {
    getTelemetryQueue.mockReset();
    getExecutionCtx.mockReset();
    persistTelemetryMessages.mockReset();
  });

  it("persists inline without a Worker queue binding", async () => {
    getTelemetryQueue.mockReturnValue(undefined);
    await emitTelemetry({} as never, event);
    expect(persistTelemetryMessages).toHaveBeenCalledWith({}, [event]);
  });

  it("awaits queue publication and swallows failures with no execution context", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    getTelemetryQueue.mockReturnValue({ send });
    getExecutionCtx.mockReturnValue(undefined);

    await expect(emitTelemetry({} as never, event)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(event);
    expect(persistTelemetryMessages).not.toHaveBeenCalled();
  });

  it("hands the send to waitUntil instead of blocking the caller", async () => {
    // The point of the change: the caller returns without the queue round trip
    // on its critical path. Resolving `send` only after emitTelemetry has
    // already settled is what proves it was never awaited.
    let release: (() => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const waitUntil = vi.fn();
    getTelemetryQueue.mockReturnValue({ send });
    getExecutionCtx.mockReturnValue({ waitUntil });

    await expect(emitTelemetry({} as never, event)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith(event);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    release?.();
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });

  it("keeps a waitUntil send failure from surfacing as an unhandled rejection", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    const waitUntil = vi.fn();
    getTelemetryQueue.mockReturnValue({ send });
    getExecutionCtx.mockReturnValue({ waitUntil });

    await expect(emitTelemetry({} as never, event)).resolves.toBeUndefined();
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
  });
});
