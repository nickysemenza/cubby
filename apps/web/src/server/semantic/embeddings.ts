import type { RunId } from "@cubby/schemas/identifiers";
import { embed } from "@tanstack/ai";
import {
  createOpenaiEmbedding,
  type OpenAIEmbeddingAdapter,
} from "@tanstack/ai-openai";
import { LRUCache } from "lru-cache";

import { recordAiUsage } from "~/server/ai-usage";
import { SEMANTIC_QUERY_FEATURE } from "~/server/ai/features";
import { cachedCall } from "~/server/clients/ai-adapters";
import {
  gatewayBaseURL,
  gatewayConfigured,
  gatewayFetch,
  type GatewayMetadata,
} from "~/server/clients/ai-gateway";
import type { Database } from "~/server/db";
import { ensureRun, systemActor } from "~/server/runs/ensure-run";
import { TraceNames, withTrace } from "~/server/tracing";

import {
  getSemanticEmbeddingConfig,
  type SemanticEmbeddingConfig,
} from "./config";
import { productionVectorStore, type VectorStorePort } from "./vector-store";

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
  /** Provider reachability only; `embedTexts` guards on this alone. */
  readonly configured: () => boolean;
  readonly vectorStore: VectorStorePort;
  readonly recordAiUsage: typeof recordAiUsage;
  readonly config: typeof getSemanticEmbeddingConfig;
}

/** Exported so a test can swap one port and keep the real transport. */
export const productionEmbeddingPorts: EmbeddingPorts = {
  adapter: (config, metadata) =>
    createOpenaiEmbedding(config.model, UNIFIED_BILLING_PLACEHOLDER_KEY, {
      baseURL: gatewayBaseURL("openai"),
      // The gateway keys its cache on the request body, so changed text
      // always misses; caching only ever short-circuits an identical
      // (model, input) pair, which is deterministic. Repeat search queries
      // were paying the full provider round-trip (p50 ~940ms) without this.
      fetch: gatewayFetch("openai", cachedCall({ metadata })),
    }),
  configured: gatewayConfigured,
  vectorStore: productionVectorStore,
  recordAiUsage,
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
     * request's `ai_action` (or an inherited) run should pass it.
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
    const startedAt = performance.now();
    const metadata: GatewayMetadata = {
      feature,
      operation,
      inputCount: texts.length,
    };
    const result = await embed({
      adapter: ports.adapter(config, metadata),
      input: texts,
      dimensions: config.dimensions,
    });

    if (opts?.db) {
      const runId =
        opts.runId ??
        (await ensureRun(opts.db, systemActor(), {
          purpose: "background",
          clientKey: `embeddings:${new Date().toISOString().slice(0, 10)}`,
        }));
      await ports.recordAiUsage(opts.db, {
        feature,
        provider: config.provider,
        model: config.model,
        operation,
        runId,
        inputTokens:
          result.usage?.promptTokens ?? result.usage?.totalTokens ?? null,
        outputTokens: null,
        durationMs: Math.round(performance.now() - startedAt),
        cacheStatus: "none",
        entity: opts.entity,
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
