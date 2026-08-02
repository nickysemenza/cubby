import { beforeEach, describe, expect, it, vi } from "vitest";

const emitTelemetry = vi.fn();
vi.mock("~/server/telemetry", () => ({ emitTelemetry }));

const { recordAiUsage } = await import("./ai-usage");

describe("recordAiUsage", () => {
  beforeEach(() => emitTelemetry.mockReset());

  it("preserves AI usage fields in the queued event", async () => {
    emitTelemetry.mockResolvedValue(undefined);
    await recordAiUsage({} as never, {
      feature: "embeddings",
      provider: "openai",
      model: "text-embedding-3-small",
      operation: "embed",
      inputTokens: 12,
      outputTokens: 0,
      durationMs: 31,
      cacheStatus: "none",
      entity: {
        entityType: "product",
        entityId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
      },
      batchId: "a04c5cf6-707b-4367-b6fa-b924541e8be2",
    });

    expect(emitTelemetry).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        type: "ai_usage",
        feature: "embeddings",
        inputTokens: 12,
        outputTokens: 0,
        entityType: "product",
        entityId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
        batchId: "a04c5cf6-707b-4367-b6fa-b924541e8be2",
      }),
    );
  });
});
