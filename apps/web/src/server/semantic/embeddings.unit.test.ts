import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "~/server/db";

const recordAiUsageMock = vi.hoisted(() => vi.fn());

vi.mock("~/env", () => ({
  env: {
    AI_GATEWAY_API_KEY: "test-gateway-key",
  },
}));

vi.mock("~/server/cf-env", () => ({
  CF_ACCOUNT_ID: "test-account",
  CF_AIG_GATEWAY_ID: "test-gateway",
}));

vi.mock("~/server/ai-usage", () => ({
  recordAiUsage: recordAiUsageMock,
}));

function embedding(dimensions = 1536): number[] {
  return Array.from({ length: dimensions }, (_, index) => index / dimensions);
}

describe("embedTexts usage recording", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    recordAiUsageMock.mockClear();
  });

  it("records AI usage for embedding calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ embedding: embedding() }],
          usage: { prompt_tokens: 4, total_tokens: 4 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { embedTexts } = await import("./embeddings");
    const db = {} as Database;

    await embedTexts(["eggs"], {
      db,
      feature: "entity-embedding",
      operation: "entityEmbeddingBackfill",
      batchId: "00000000-0000-4000-8000-000000000001",
      entity: {
        entityType: "product",
        entityId: "00000000-0000-4000-8000-000000000002",
      },
    });

    expect(recordAiUsageMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        feature: "entity-embedding",
        provider: "openai",
        model: "text-embedding-3-small",
        operation: "entityEmbeddingBackfill",
        inputTokens: 4,
        cacheStatus: "none",
        batchId: "00000000-0000-4000-8000-000000000001",
        entity: {
          entityType: "product",
          entityId: "00000000-0000-4000-8000-000000000002",
        },
      }),
    );
  });
});
