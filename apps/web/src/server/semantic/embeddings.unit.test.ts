import { runEntityId } from "@cubby/schemas/identifiers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AI_CACHE_TTL_SECONDS } from "~/server/clients/ai-adapters";
import { Database } from "~/server/db";

import type { EmbeddingPorts } from "./embeddings";

const db = new Database(() => {
  throw new Error("Embedding unit ports do not resolve a database runtime");
});
const runId = runEntityId.parse("00000000-0000-4000-8000-000000000001");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function embedding(dimensions = 1536): number[] {
  return Array.from({ length: dimensions }, (_, index) => index / dimensions);
}

/**
 * The real adapter and the real gateway shim, faked only at the socket.
 *
 * Stubbing `embed()` or the adapter would leave the two things that actually
 * regress — one request for the whole array, and the gateway metadata that
 * bills and attributes it — unobserved. `~/env` snapshots `process.env` at
 * module load, so the REST branch needs a fresh module graph after stubbing;
 * that graph also has no Worker binding, which is the dev server's shape.
 */
/** The OpenAI embeddings response shape the adapter's SDK decodes. */
interface OpenAiEmbeddingsResponse {
  object: "list";
  model: string;
  data: Array<{ object: "embedding"; index: number; embedding: number[] }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

async function embedTextsOverFakeGateway(response: OpenAiEmbeddingsResponse) {
  vi.stubEnv("AI_GATEWAY_API_KEY", "test-gateway-key");
  vi.resetModules();
  const sent: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  const { embedTexts, productionEmbeddingPorts } = await import("./embeddings");
  return { embedTexts, productionEmbeddingPorts, sent };
}

const openAiEmbeddingsResponse = (count: number): OpenAiEmbeddingsResponse => ({
  object: "list",
  model: "text-embedding-3-small",
  data: Array.from({ length: count }, (_, index) => ({
    object: "embedding",
    index,
    embedding: embedding(),
  })),
  usage: { prompt_tokens: 4, total_tokens: 4 },
});

describe("embedTexts over the AI Gateway", () => {
  it("sends one request carrying every text, the dimensions, and the call's metadata", async () => {
    const { embedTexts, sent } = await embedTextsOverFakeGateway(
      openAiEmbeddingsResponse(3),
    );

    const vectors = await embedTexts(["eggs", "flour", "butter"], {
      feature: "entity-embedding",
      operation: "entityEmbeddingRefreshBatch",
    });

    expect(vectors).toHaveLength(3);
    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call?.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/9f10f078d35d86c78dedece2300a6b88/cubby/openai/embeddings",
    );
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      model: "text-embedding-3-small",
      dimensions: 1536,
      input: ["eggs", "flour", "butter"],
    });
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-aig-authorization")).toBe("Bearer test-gateway-key");
    // Regression: embeddings once sent `cf-aig-skip-cache`, so identical
    // search queries paid the full provider round-trip every time.
    expect(headers.get("cf-aig-skip-cache")).toBeNull();
    expect(headers.get("cf-aig-cache-ttl")).toBe(String(AI_CACHE_TTL_SECONDS));
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).toEqual({
      feature: "entity-embedding",
      operation: "entityEmbeddingRefreshBatch",
      inputCount: 3,
    });
  });

  it("returns vectors in input order even when the provider reorders them", async () => {
    const { embedTexts } = await embedTextsOverFakeGateway({
      object: "list",
      model: "text-embedding-3-small",
      data: [
        { object: "embedding", index: 1, embedding: embedding().fill(0.5) },
        { object: "embedding", index: 0, embedding: embedding().fill(0.25) },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });

    const vectors = await embedTexts(["first", "second"]);

    expect(vectors[0]?.[0]).toBe(0.25);
    expect(vectors[1]?.[0]).toBe(0.5);
  });
});

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
    const { embedTexts, productionEmbeddingPorts } =
      await embedTextsOverFakeGateway(openAiEmbeddingsResponse(1));
    const ports = {
      ...productionEmbeddingPorts,
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
    } satisfies EmbeddingPorts;

    await embedTexts(
      ["eggs"],
      {
        db,
        runId,
        feature: "entity-embedding",
        operation: "entityEmbeddingBackfill",
        entity: {
          entityKind: "product",
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
