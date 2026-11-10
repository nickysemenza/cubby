import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AI_CACHE_TTL_SECONDS } from "~/server/ai/adapters";
import { gatewayEgressEnv } from "~/server/testing/ai-gateway-egress";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function embedding(dimensions = 1536): number[] {
  return Array.from({ length: dimensions }, (_, index) => index / dimensions);
}

/** The OpenAI embeddings response shape the adapter's SDK decodes. */
interface OpenAiEmbeddingsResponse {
  object: "list";
  model: string;
  data: Array<{ object: "embedding"; index: number; embedding: number[] }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * The real adapter and the real gateway shim, faked only at the socket.
 *
 * Stubbing `embed()` or the adapter would leave the two things that actually
 * regress — one request for the whole array, and the gateway metadata that
 * bills and attributes it — unobserved.
 */
async function embedTextsOverFakeGateway(response: OpenAiEmbeddingsResponse) {
  vi.stubEnv("CI", "");
  vi.resetModules();
  (await import("~/server/cf-env")).setCfEnv(
    fromPartial<Env>(gatewayEgressEnv("test-gateway-key")),
  );
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
  const { embedTexts } = await import("./embeddings");
  return { embedTexts, sent };
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
  it("reports the embedding model and operation when the gateway rejects a request", async () => {
    const { embedTexts } = await embedTextsOverFakeGateway(
      openAiEmbeddingsResponse(1),
    );
    vi.stubGlobal(
      "fetch",
      async () => new Response('{"error":"rate limited"}', { status: 429 }),
    );
    await expect(
      embedTexts(["synthetic input"], {
        feature: "entity-embedding",
        operation: "refresh",
      }),
    ).rejects.toThrow(/model: text-embedding-3-small.*operation: refresh/u);
  });

  it("pays Unified Billing when OpenAI credit refuses", async () => {
    const { embedTexts } = await embedTextsOverFakeGateway(
      openAiEmbeddingsResponse(1),
    );
    const sent: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return sent.length === 1
        ? Response.json(
            { error: { code: "insufficient_quota", message: "synthetic" } },
            { status: 429 },
          )
        : Response.json({ result: openAiEmbeddingsResponse(1) });
    });

    expect(await embedTexts(["eggs"])).toHaveLength(1);
    expect(sent[1]).toMatchObject({
      url: expect.stringMatching(/\/run$/u),
      body: {
        model: "openai/text-embedding-3-small",
        input: { input: ["eggs"], dimensions: 1536 },
      },
    });
  });
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
    // The default OpenAI key stays unset for explicit paid chat fallback.
    expect(headers.get("cf-aig-byok-alias")).toBe("subscriber-credit");
    expect(headers.get("cf-aig-no-wholesale")).toBe("true");
    // Regression: embeddings once sent `cf-aig-skip-cache`, so identical
    // search queries paid the full provider round-trip every time.
    expect(headers.get("cf-aig-skip-cache")).toBeNull();
    expect(headers.get("cf-aig-cache-ttl")).toBe(String(AI_CACHE_TTL_SECONDS));
    expect(JSON.parse(headers.get("cf-aig-metadata") ?? "{}")).toEqual({
      feature: "entity-embedding",
      operation: "entityEmbeddingRefreshBatch",
      environment: "development",
    });
  });

  // Regression: entity refreshes paid to re-embed texts they had embedded.
  it("embeds only the texts missing from the response cache", async () => {
    const { embedTexts } = await embedTextsOverFakeGateway(
      openAiEmbeddingsResponse(1),
    );
    const inputs: string[][] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const { input } = z
        .object({ input: z.array(z.string()) })
        .parse(JSON.parse(String(init?.body)));
      inputs.push(input);
      return Response.json(openAiEmbeddingsResponse(input.length));
    });
    await embedTexts(["eggs", "flour"]);
    expect(await embedTexts(["flour", "butter", "flour"])).toHaveLength(3);
    expect(inputs).toEqual([["eggs", "flour"], ["butter"]]);
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

  // Regression: a settled-suggestion recheck prepared a semantic roster and,
  // on a cold query cache, paid the embeddings provider for it.
  it("makes no provider call for a cold query inside provider-free preparation", async () => {
    const { sent } = await embedTextsOverFakeGateway(
      openAiEmbeddingsResponse(1),
    );
    const cfEnv = await import("~/server/cf-env");
    vi.spyOn(cfEnv, "getVectorIndex").mockReturnValue(
      fromPartial<NonNullable<ReturnType<typeof cfEnv.getVectorIndex>>>({}),
    );
    const { embedQuery, semanticEmbeddingsConfigured } =
      await import("./embeddings");
    const { withAiInputs } = await import("~/server/ai/evaluation-inputs");
    expect(semanticEmbeddingsConfigured()).toBe(true);

    const prepared = await withAiInputs(
      true,
      () => embedQuery("synthetic cold pantry staple"),
      { providerFree: true },
    );

    expect(prepared.result).toBeNull();
    expect(prepared.incomplete).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
