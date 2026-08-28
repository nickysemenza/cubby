import { LRUCache } from "lru-cache";
import { z } from "zod";

import { env } from "~/env";
import { recordAiUsage } from "~/server/ai-usage";
import { CF_ACCOUNT_ID, CF_AIG_GATEWAY_ID } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { TraceNames, withTrace } from "~/server/tracing";

import { getSemanticEmbeddingConfig } from "./config";

const embeddingResponseSchema = z.object({
  data: z
    .array(z.object({ embedding: z.array(z.number()).optional() }))
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export interface EmbeddingPorts {
  readonly apiKey: string | undefined;
  readonly accountId: string;
  readonly gatewayId: string;
  readonly fetch: typeof fetch;
  readonly recordAiUsage: typeof recordAiUsage;
  readonly config: typeof getSemanticEmbeddingConfig;
}

const productionEmbeddingPorts: EmbeddingPorts = {
  apiKey: env.AI_GATEWAY_API_KEY,
  accountId: CF_ACCOUNT_ID,
  gatewayId: CF_AIG_GATEWAY_ID,
  fetch,
  recordAiUsage,
  config: getSemanticEmbeddingConfig,
};

const queryEmbeddingCache = new LRUCache<string, number[]>({
  max: 500,
  ttl: 1000 * 60 * 60,
});

function gatewayEmbeddingsUrl(ports: EmbeddingPorts): string {
  return `https://gateway.ai.cloudflare.com/v1/${ports.accountId}/${ports.gatewayId}/openai/embeddings`;
}

function embeddingHeaders(ports: EmbeddingPorts): HeadersInit | null {
  const headers = new Headers({ "content-type": "application/json" });

  if (ports.apiKey) {
    headers.set("cf-aig-authorization", `Bearer ${ports.apiKey}`);
  }

  if (!headers.has("cf-aig-authorization")) {
    return null;
  }

  return headers;
}

export function semanticEmbeddingsConfigured(
  ports: EmbeddingPorts = productionEmbeddingPorts,
): boolean {
  return embeddingHeaders(ports) !== null;
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
  ports: EmbeddingPorts = productionEmbeddingPorts,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const headers = embeddingHeaders(ports);
  if (!headers) {
    throw new Error(
      "Semantic embeddings are not configured. Set AI_GATEWAY_API_KEY so Cubby can call Cloudflare AI Gateway.",
    );
  }

  return withTrace(
    TraceNames.api("embeddings", opts?.operation ?? "embeddings"),
    async (span) => {
      const config = ports.config();
      span.setAttributes({
        "ai.provider": config.provider,
        "ai.model": config.model,
        "ai.dimensions": config.dimensions,
        "ai.input_count": texts.length,
      });
      const startedAt = performance.now();
      const response = await ports.fetch(gatewayEmbeddingsUrl(ports), {
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

      const json = embeddingResponseSchema.parse(await response.json());
      if (opts?.db) {
        const inputTokens =
          json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? null;
        await ports.recordAiUsage(opts.db, {
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
