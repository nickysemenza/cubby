import type { RunId } from "@cubby/schemas/identifiers";
import { gatewayBaseURL } from "@cubby/shared/ai/gateway-request";
import { LRUCache } from "lru-cache";
import { z } from "zod";

import { cachedCall } from "~/server/ai/adapters";
import { SEMANTIC_QUERY_FEATURE } from "~/server/ai/features";
import {
  gatewayConfigured,
  gatewayFetch,
  type GatewayMetadata,
} from "~/server/ai/gateway";
import {
  type EmbeddingObservers,
  runEmbeddingFeature,
} from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { ensureRun, systemActor } from "~/server/runs/ensure-run";
import { TraceNames, withTrace } from "~/server/tracing";

import { getSemanticEmbeddingConfig } from "./config";
import { productionVectorStore, type VectorStorePort } from "./vector-store";

/** The OpenAI embeddings endpoint's response shape, parsed directly — there
 * is no provider SDK on this path, just the gateway's `/openai/embeddings`. */
const embeddingsResponseSchema = z.object({
  data: z.array(
    z.object({ index: z.number(), embedding: z.array(z.number()) }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export interface EmbeddingPorts {
  /**
   * One fetch per call: the gateway's request metadata is fixed when the
   * transport is built, so it cannot be hoisted to a shared client.
   */
  readonly fetchFor: (
    metadata: GatewayMetadata,
    observers: EmbeddingObservers,
  ) => typeof fetch;
  /** Provider reachability only; `embedTexts` guards on this alone. */
  readonly configured: () => boolean;
  readonly vectorStore: VectorStorePort;
  readonly config: typeof getSemanticEmbeddingConfig;
}

const productionEmbeddingPorts: EmbeddingPorts = {
  // The gateway keys its cache on the request body, so changed text always
  // misses; caching only ever short-circuits an identical (model, input)
  // pair, which is deterministic. Repeat search queries were paying the full
  // provider round-trip (p50 ~940ms) without this.
  fetchFor: (metadata, observers) =>
    gatewayFetch("openai", { ...cachedCall({ metadata }), ...observers }),
  configured: gatewayConfigured,
  vectorStore: productionVectorStore,
  config: getSemanticEmbeddingConfig,
};

const queryEmbeddingCache = new LRUCache<string, number[]>({
  max: 500,
  ttl: 1000 * 60 * 60,
});

/**
 * The one gate every semantic consumer asks. An embedding is only useful if
 * there is somewhere to store and search it: on the vite Node dev server the
 * gateway may be reachable via AI_GATEWAY_API_KEY while the Vectorize binding
 * is absent, and reporting "configured" there would let the Problems detector
 * flag the whole corpus as missing with no way to clear it.
 */
export function semanticEmbeddingsConfigured(
  ports: EmbeddingPorts = productionEmbeddingPorts,
): boolean {
  return ports.configured() && ports.vectorStore.configured();
}

/**
 * One provider request for the whole array — the adapter batches natively, so
 * `texts.length` vectors come back from a single call regardless of size.
 */
export async function embedTexts(
  texts: string[],
  opts?: {
    operation?: string;
    db?: Database;
    /**
     * Every AI call belongs to a run. Most `embedTexts` callers sit several
     * layers below the request handler that could mint one (generic search
     * infrastructure fanned out across many read paths) — omitted, this
     * books the call under a `background`-purpose run rather than forcing
     * that plumbing everywhere `db` is threaded. Those land in one system
     * run per day, not one per search. A caller that already has the
     * request's `ai_suggest` (or an inherited) run should pass it.
     */
    runId?: RunId;
    feature?: string;
    entity?: { entityKind: string; entityId: string };
  },
  ports: EmbeddingPorts = productionEmbeddingPorts,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!ports.configured()) {
    throw new Error(
      "Semantic embeddings are not configured. Set AI_GATEWAY_API_KEY so Cubby can call Cloudflare AI Gateway.",
    );
  }
  const operation = opts?.operation ?? "embeddings";
  const feature = opts?.feature ?? SEMANTIC_QUERY_FEATURE.feature;

  return withTrace(TraceNames.api("embeddings", operation), async (span) => {
    const config = ports.config();
    span.setAttributes({
      "ai.provider": config.provider,
      "ai.model": config.model,
      "ai.dimensions": config.dimensions,
      "ai.input_count": texts.length,
    });
    const metadata: GatewayMetadata = { feature, operation };
    const runId = opts?.db
      ? (opts.runId ??
        (await ensureRun(opts.db, systemActor(), {
          purpose: "background",
          // oxlint-disable-next-line cubby/no-ad-hoc-calendar-day -- an operational daily bucket
          clientKey: `embeddings:${new Date().toISOString().slice(0, 10)}`,
        })))
      : undefined;
    const result = await runEmbeddingFeature(
      { feature, model: config.model },
      {
        embed: async (observers) => {
          const fetchThroughGateway = ports.fetchFor(metadata, observers);
          const response = await fetchThroughGateway(
            `${gatewayBaseURL("openai")}/embeddings`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: config.model,
                input: texts,
                dimensions: config.dimensions,
              }),
            },
          );
          if (!response.ok) {
            throw new Error(
              `Embeddings request failed (HTTP ${response.status} ${response.statusText}): ${await response.text()}`,
            );
          }
          const body = embeddingsResponseSchema.parse(await response.json());
          return {
            embeddings: body.data.map((item) => ({
              index: item.index,
              vector: item.embedding,
            })),
            usage: {
              promptTokens: body.usage?.prompt_tokens ?? null,
              totalTokens: body.usage?.total_tokens ?? null,
            },
          };
        },
      },
      { db: opts?.db, runId, operation, entity: opts?.entity },
    );

    // Ordered by the reported input position, not by arrival. A batch caller
    // zips these against its own refs, so a reordered response would write
    // every vector onto the wrong entity — silently, and only detectably as
    // bad search results months later.
    const embeddings = [...result.embeddings]
      .sort((left, right) => left.index - right.index)
      .map((item) => item.vector);
    if (embeddings.length !== texts.length) {
      throw new Error(
        `Embedding response returned ${embeddings.length} vectors for ${texts.length} inputs`,
      );
    }
    for (const embedding of embeddings) {
      if (embedding.length !== config.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${config.dimensions}, got ${embedding.length}`,
        );
      }
    }
    return embeddings;
  });
}

export async function embedQuery(
  query: string,
  opts?: { db?: Database; runId?: RunId },
): Promise<number[] | null> {
  if (!semanticEmbeddingsConfigured()) return null;
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return null;
  const cached = queryEmbeddingCache.get(normalized);
  if (cached) return cached;
  const [embedding] = await embedTexts([normalized], {
    operation: "queryEmbedding",
    db: opts?.db,
    runId: opts?.runId,
    feature: SEMANTIC_QUERY_FEATURE.feature,
  });
  if (!embedding) return null;
  queryEmbeddingCache.set(normalized, embedding);
  return embedding;
}
