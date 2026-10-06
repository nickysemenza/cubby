import { runEntityId } from "@cubby/schemas/identifiers";
import { describe, expect, it, vi } from "vitest";

import { Database } from "~/server/db";

import {
  type AiUsagePort,
  type RecordAiUsageInput,
  recordAiUsage,
} from "./usage";

const runId = runEntityId.parse("00000000-0000-4000-8000-000000000001");

const db = new Database(() => {
  throw new Error("The injected telemetry port must not access the database");
});

describe("recordAiUsage", () => {
  it("preserves AI usage fields in the queued event", async () => {
    const emit = vi.fn<AiUsagePort["emit"]>();
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
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 31,
        cacheStatus: "none",
        applicationCacheStatus: "hit",
        transport: "cache",
        attempt: 0,
        estimatedCost: 0,
        entity: {
          entityKind: "product",
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
        inputTokens: 0,
        applicationCacheStatus: "hit",
        transport: "cache",
        attempt: 0,
        estimatedCost: 0,
        outputTokens: 0,
        entityKind: "product",
        entityId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
      }),
    );
  });

  // Accounting rules live in this writer so every caller — runner, crate
  // forwarder, audit recovery, agent coordinator — books the same way.
  async function emitted(input: Partial<RecordAiUsageInput>) {
    const emit = vi.fn<AiUsagePort["emit"]>();
    await recordAiUsage(
      db,
      {
        feature: "location-description",
        provider: "openai",
        model: "gpt-6-luna",
        operation: "locationDescription",
        runId,
        durationMs: 3,
        transport: "gateway",
        ...input,
      },
      { emit },
    );
    return emit.mock.calls[0]?.[1];
  }

  // Regression: AiAnalysis/recipe-flow replays omitted attempt and cost, so
  // the row defaulted to one attempt and was later priced from its tokens.
  it("books a caller-cache replay as zero attempts at no cost", async () => {
    expect(
      await emitted({
        transport: "cache",
        cacheStatus: "hit",
        inputTokens: 1_000,
      }),
    ).toMatchObject({
      transport: "cache",
      cacheStatus: "hit",
      attempt: 0,
      estimatedCost: 0,
    });
  });

  it("books ChatGPT plan usage at no cost but keeps its model attempts", async () => {
    expect(
      await emitted({
        transport: "chatgpt",
        attempt: 2,
        inputTokens: 1_000,
        estimatedCost: 0.42,
      }),
    ).toMatchObject({ transport: "chatgpt", attempt: 2, estimatedCost: 0 });
  });

  // A Gateway response-cache HIT still crossed the gateway and repeats the
  // provider's token figures; only its price is zero. The caller's own cache
  // state stays in `cacheStatus` untouched.
  it("books a gateway cache hit free without erasing its transport, tokens, or caller cache state", async () => {
    const event = await emitted({
      gatewayCacheStatus: "hit",
      gatewayLogId: "log-synthetic",
      cacheStatus: "miss",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      estimatedCost: 0.003,
    });
    expect(event).toMatchObject({
      transport: "gateway",
      gatewayLogId: "log-synthetic",
      cacheStatus: "miss",
      attempt: 1,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      estimatedCost: 0,
    });
    expect(event).not.toHaveProperty("gatewayCacheStatus");
  });

  it("keeps a gateway miss's own cost", async () => {
    expect(
      await emitted({ gatewayCacheStatus: "miss", estimatedCost: 0.003 }),
    ).toMatchObject({ estimatedCost: 0.003 });
  });
});
