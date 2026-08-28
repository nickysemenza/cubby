import { describe, expect, it } from "vitest";

import { Database } from "~/server/db";

import { getSemanticEmbeddingConfig } from "./config";
import { embedTexts, type EmbeddingPorts } from "./embeddings";

const db = new Database(() => {
  throw new Error("Embedding unit ports do not resolve a database runtime");
});

function embedding(dimensions = 1536): number[] {
  return Array.from({ length: dimensions }, (_, index) => index / dimensions);
}

describe("embedTexts usage recording", () => {
  it("records AI usage for embedding calls through the external gateway port", async () => {
    const usage: Array<{
      feature: string;
      provider: string;
      model: string;
      operation: string;
      inputTokens: number | null | undefined;
      cacheStatus: string | null | undefined;
    }> = [];
    const ports = {
      apiKey: "test-gateway-key",
      accountId: "test-account",
      gatewayId: "test-gateway",
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: embedding() }],
            usage: { prompt_tokens: 4, total_tokens: 4 },
          }),
          { status: 200 },
        ),
      recordAiUsage: async (_db, record) => {
        usage.push({
          feature: record.feature,
          provider: record.provider,
          model: record.model,
          operation: record.operation,
          inputTokens: record.inputTokens,
          cacheStatus: record.cacheStatus,
        });
      },
      config: getSemanticEmbeddingConfig,
    } satisfies EmbeddingPorts;

    await embedTexts(
      ["eggs"],
      {
        db,
        feature: "entity-embedding",
        operation: "entityEmbeddingBackfill",
        batchId: "00000000-0000-4000-8000-000000000001",
        entity: {
          entityType: "product",
          entityId: "00000000-0000-4000-8000-000000000002",
        },
      },
      ports,
    );

    expect(usage).toEqual([
      {
        feature: "entity-embedding",
        provider: "openai",
        model: "text-embedding-3-small",
        operation: "entityEmbeddingBackfill",
        inputTokens: 4,
        cacheStatus: "none",
      },
    ]);
  });
});
