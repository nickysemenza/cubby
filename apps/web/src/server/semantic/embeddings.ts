import { LRUCache } from "lru-cache";
import { env } from "~/env";
import { CF_ACCOUNT_ID, CF_AIG_GATEWAY_ID } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { recordAiUsage } from "~/server/repo/ai-usage";
import { TraceNames, withTrace } from "~/server/tracing";
import { getSemanticEmbeddingConfig } from "./config";

interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  usage?: {
    prompt_tokens?: number;
    total_tokens?: number;
  };
}

const queryEmbeddingCache = new LRUCache<string, number[]>({
  max: 500,
  ttl: 1000 * 60 * 60,
});

function gatewayEmbeddingsUrl(): string {
  return `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_AIG_GATEWAY_ID}/openai/embeddings`;
}

function embeddingHeaders(): HeadersInit | null {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (env.AI_GATEWAY_API_KEY) {
    headers["cf-aig-authorization"] = `Bearer ${env.AI_GATEWAY_API_KEY}`;
  }

  if (!headers["cf-aig-authorization"]) {
    return null;
  }

  return headers;
}

export function semanticEmbeddingsConfigured(): boolean {
  return embeddingHeaders() !== null;
}

export async function embedTexts(
  texts: string[],
  opts?: {
    operation?: string;
    db?: Database;
    feature?: string;
    entity?: { entityType: string; entityId: string };
    batchId?: string;
  },
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const headers = embeddingHeaders();
  if (!headers) {
    throw new Error(
      "Semantic embeddings are not configured. Set AI_GATEWAY_API_KEY so Cubby can call Cloudflare AI Gateway.",
    );
  }

  return withTrace(
    TraceNames.api("embeddings", opts?.operation ?? "embeddings"),
    async (span) => {
      const config = getSemanticEmbeddingConfig();
      span.setAttributes({
        "ai.provider": config.provider,
        "ai.model": config.model,
        "ai.dimensions": config.dimensions,
        "ai.input_count": texts.length,
      });
      const startedAt = performance.now();
      const response = await fetch(gatewayEmbeddingsUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: config.model,
          dimensions: config.dimensions,
          input: texts,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Embedding request failed: ${response.status} ${body.slice(0, 500)}`,
        );
      }

      const json = (await response.json()) as EmbeddingResponse;
      if (opts?.db) {
        const inputTokens =
          json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? null;
        await recordAiUsage(opts.db, {
          feature: opts.feature ?? "semantic-embedding",
          provider: config.provider,
          model: config.model,
          operation: opts.operation ?? "embeddings",
          inputTokens,
          outputTokens: null,
          durationMs: Math.round(performance.now() - startedAt),
          cacheStatus: "none",
          entity: opts.entity,
          batchId: opts.batchId,
        });
      }
      const embeddings = json.data?.map((row) => row.embedding ?? []) ?? [];
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
    },
  );
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
