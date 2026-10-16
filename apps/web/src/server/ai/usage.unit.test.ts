import { runEntityId } from "@cubby/schemas/identifiers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "~/server/db/database-runtime";

import type { snapshotAiUsagePrice } from "./pricing";
import {
  type AiUsagePort,
  type RecordAiUsageInput,
  recordAiUsage,
} from "./usage";
const snapshot = vi.fn<typeof snapshotAiUsagePrice>();
beforeEach(() => snapshot.mockResolvedValue({ amount: null, evidence: null }));

const runId = runEntityId.parse("00000000-0000-4000-8000-000000000001");

const db = createDatabase(() => {
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
        chargedCost: 0,
        entity: {
          entityKind: "product",
          entityId: "9d4f70aa-5c8f-4f24-b7f8-d67d28111d86",
        },
      },
      { emit, snapshot },
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
        chargedCost: 0,
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
      { emit, snapshot },
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
      chargedCost: 0,
    });
  });

  it("books ChatGPT plan usage at no cost but keeps its model attempts", async () => {
    expect(
      await emitted({
        transport: "chatgpt",
        attempt: 2,
        inputTokens: 1_000,
        standardCost: 0.42,
        chargedCost: 0.42,
      }),
    ).toMatchObject({
      transport: "chatgpt",
      attempt: 2,
      standardCost: 0.42,
      chargedCost: 0,
    });
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
      standardCost: 0.003,
      chargedCost: 0.003,
    });
    expect(event).toMatchObject({
      transport: "gateway",
      gatewayLogId: "log-synthetic",
      standardCost: 0.003,
      cacheStatus: "miss",
      attempt: 1,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      chargedCost: 0,
    });
    expect(event).not.toHaveProperty("gatewayCacheStatus");
  });

  it("keeps a gateway hit with zero token placeholders unpriced without equivalent inference evidence", async () => {
    const quote = {
      source: "estimate" as const,
      pricingSource: "models.dev" as const,
      pricingSnapshot: {
        provider: "openai",
        model: "gpt-6-luna",
        capturedAt: "2026-01-01T00:00:00Z",
        rates: { input: 2, output: 0 },
      },
    };
    snapshot.mockResolvedValue({ amount: 0, evidence: quote });
    const placeholders = {
      gatewayCacheStatus: "hit" as const,
      inputTokens: 0,
      outputTokens: 0,
    };
    expect(await emitted(placeholders)).toMatchObject({
      standardCost: null,
      chargedCost: 0,
      costEvidence: { standard: null, billingReason: "cache" },
    });
    expect(
      await emitted({
        ...placeholders,
        standardCost: 0,
        chargedCost: 0,
        costEvidence: {
          standard: { ...quote, pricingSource: "pi_sdk" },
          charged: { source: "estimate" },
          billingReason: "standard",
        },
      }),
    ).toMatchObject({ standardCost: null, chargedCost: 0 });
    expect(
      await emitted({
        ...placeholders,
        standardCost: 0.003,
        costEvidence: {
          standard: quote,
          charged: null,
          billingReason: "cache",
        },
      }),
    ).toMatchObject({ standardCost: 0.003, chargedCost: 0 });
  });

  it("uses the same canonical standard rates for SDK and token-only calls", async () => {
    const canonical = {
      source: "estimate" as const,
      pricingSource: "models.dev" as const,
      pricingSnapshot: {
        provider: "openai",
        model: "gpt-6-luna",
        capturedAt: "2026-01-01T00:00:00Z",
        rates: { input: 2, output: 0 },
      },
    };
    const sdk = {
      ...canonical,
      pricingSource: "pi_sdk" as const,
      pricingSnapshot: {
        ...canonical.pricingSnapshot,
        rates: { input: 3, output: 0 },
      },
    };
    snapshot.mockResolvedValue({ amount: 0.002, evidence: canonical });
    const usage = { inputTokens: 1000, outputTokens: 0 };
    const sdkCall = await emitted({
      ...usage,
      standardCost: 0.003,
      chargedCost: 0.003,
      costEvidence: { standard: sdk, charged: sdk, billingReason: "standard" },
    });
    const tokenCall = await emitted(usage);
    expect(sdkCall).toMatchObject({
      standardCost: 0.002,
      chargedCost: 0.003,
      costEvidence: { standard: canonical, charged: sdk },
    });
    expect(tokenCall).toMatchObject({
      standardCost: 0.002,
      chargedCost: 0.002,
      costEvidence: { standard: canonical },
    });
  });

  it("labels a supplied comparison fallback when the canonical quote is unavailable", async () => {
    expect(
      await emitted({ standardCost: 0.003, chargedCost: 0.002 }),
    ).toMatchObject({
      standardCost: 0.003,
      chargedCost: 0.002,
      costEvidence: {
        standard: { source: "estimate", pricingSource: "caller" },
      },
    });
    expect(
      await emitted({
        transport: "cache",
        standardCost: 0.003,
        inputTokens: 1000,
      }),
    ).toMatchObject({ standardCost: null, chargedCost: 0 });
  });

  it("keeps a gateway miss's own cost", async () => {
    expect(
      await emitted({ gatewayCacheStatus: "miss", chargedCost: 0.003 }),
    ).toMatchObject({ chargedCost: 0.003 });
  });
});
