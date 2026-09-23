import { importRunId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import { type AiUsagePort, recordAiUsage } from "./ai-usage";

const runId = importRunId.parse("00000000-0000-4000-8000-000000000001");

describe("recordAiUsage", () => {
  it("preserves AI usage fields in the queued event", async () => {
    const emit = vi.fn<AiUsagePort["emit"]>();
    const db = new Database(() => {
      throw new Error(
        "The injected telemetry port must not access the database",
      );
    });
    await recordAiUsage(
      db,
      {
        feature: "embeddings",
        provider: "openai",
        model: "text-embedding-3-small",
        operation: "embed",
        runId,
        jobKind: "purchase_import",
        jobId: "IMRUN-fixture",
        inputTokens: 12,
        outputTokens: 0,
        durationMs: 31,
        cacheStatus: "none",
        entity: {
          entityType: "product",
          entityId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
        },
      },
      { emit },
    );

    expect(emit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        type: "ai_usage",
        feature: "embeddings",
        runId,
        jobKind: "purchase_import",
        jobId: "IMRUN-fixture",
        inputTokens: 12,
        outputTokens: 0,
        entityType: "product",
        entityId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
      }),
    );
  });
});
