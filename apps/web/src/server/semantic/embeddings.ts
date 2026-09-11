import { embed } from "@tanstack/ai";
import {
  createOpenaiEmbedding,
  type OpenAIEmbeddingAdapter,
} from "@tanstack/ai-openai";
import { LRUCache } from "lru-cache";

import { recordAiUsage } from "~/server/ai-usage";
import {
  gatewayBaseURL,
  gatewayConfigured,
  gatewayFetch,
  type GatewayMetadata,
} from "~/server/clients/ai-gateway";
import type { Database } from "~/server/db";
import { TraceNames, withTrace } from "~/server/tracing";

import {
  getSemanticEmbeddingConfig,
  type SemanticEmbeddingConfig,
} from "./config";

type SemanticEmbeddingAdapter = OpenAIEmbeddingAdapter<
  SemanticEmbeddingConfig["model"]
>;

/**
 * The gateway pays for the call under unified billing, so the SDK's mandatory
 * key slot gets a placeholder that `gatewayFetch` strips before forwarding — a
 * real `authorization` header would out-rank unified billing upstream.
 */
const UNIFIED_BILLING_PLACEHOLDER_KEY = "cf-aig-unified-billing";

export interface EmbeddingPorts {
  /**
   * One adapter per call: the gateway's request metadata is fixed when the
   * transport is built, so it cannot be hoisted to a shared client.
   */
  readonly adapter: (
    config: SemanticEmbeddingConfig,
    metadata: GatewayMetadata,
  ) => SemanticEmbeddingAdapter;
  readonly configured: () => boolean;
  readonly recordAiUsage: typeof recordAiUsage;
  readonly config: typeof getSemanticEmbeddingConfig;
}

/** Exported so a test can swap one port and keep the real transport. */
export const productionEmbeddingPorts: EmbeddingPorts = {
  adapter: (config, metadata) =>
    createOpenaiEmbedding(config.model, UNIFIED_BILLING_PLACEHOLDER_KEY, {
      baseURL: gatewayBaseURL("openai"),
      // Response caching would hand back a vector for text we just changed;
      // the whole refresh path exists because the text moved.
      fetch: gatewayFetch("openai", { metadata, skipCache: true }),
    }),
  configured: gatewayConfigured,
  recordAiUsage,
  config: getSemanticEmbeddingConfig,
};

const queryEmbeddingCache = new LRUCache<string, number[]>({
  max: 500,
  ttl: 1000 * 60 * 60,
});

export function semanticEmbeddingsConfigured(
  ports: EmbeddingPorts = productionEmbeddingPorts,
): boolean {
  return ports.configured();
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
    feature?: string;
    entity?: { entityType: string; entityId: string };
    batchId?: string;
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
  const feature = opts?.feature ?? "semantic-embedding";

  return withTrace(TraceNames.api("embeddings", operation), async (span) => {
    const config = ports.config();
    span.setAttributes({
      "ai.provider": config.provider,
      "ai.model": config.model,
      "ai.dimensions": config.dimensions,
      "ai.input_count": texts.length,
    });
    const startedAt = performance.now();
    // At most five entries survive the gateway; `batchId` is the fifth and is
    // omitted rather than displacing one of the four that always apply.
    const metadata: GatewayMetadata = {
      feature,
      operation,
      inputCount: texts.length,
    };
    if (opts?.batchId) metadata.batchId = opts.batchId;
    const result = await embed({
      adapter: ports.adapter(config, metadata),
      input: texts,
      dimensions: config.dimensions,
    });

    if (opts?.db) {
      await ports.recordAiUsage(opts.db, {
        feature,
        provider: config.provider,
        model: config.model,
        operation,
        inputTokens:
          result.usage?.promptTokens ?? result.usage?.totalTokens ?? null,
        outputTokens: null,
        durationMs: Math.round(performance.now() - startedAt),
        cacheStatus: "none",
        entity: opts.entity,
        batchId: opts.batchId,
      });
    }

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
  opts?: { db?: Database },
): Promise<number[] | null> {
  if (!semanticEmbeddingsConfigured()) return null;
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return null;
  const cached = queryEmbeddingCache.get(normalized);
  if (cached) return cached;
  const [embedding] = await embedTexts([normalized], {
    operation: "queryEmbedding",
    db: opts?.db,
    feature: "semantic-query",
  });
  if (!embedding) return null;
  queryEmbeddingCache.set(normalized, embedding);
  return embedding;
}
