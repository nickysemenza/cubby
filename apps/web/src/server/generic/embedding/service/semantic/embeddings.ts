import type { RunId } from "@cubby/schemas/identifiers";
import {
  classifyFundingRefusal,
  paidFundingRefusal,
} from "@cubby/shared/ai/funding-refusal";
import { gatewayBaseURL } from "@cubby/shared/ai/gateway-request";
import { LRUCache } from "lru-cache";
import { z } from "zod";

import { cachedCall } from "~/server/ai/adapters";
import { fundingResumeAt } from "~/server/ai/budget-window";
import {
  markPreparationIncomplete,
  preparingWithoutProviders,
} from "~/server/ai/evaluation-inputs";
import {
  gatewayConfigured,
  gatewayFetch,
  type GatewayMetadata,
} from "~/server/ai/gateway";
import { SEMANTIC_QUERY_FEATURE } from "~/server/ai/policy/features";
import {
  type EmbeddingObservers,
  runEmbeddingFeature,
} from "~/server/ai/run-feature";
import type { Database } from "~/server/db";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { TraceNames, withTrace } from "~/server/observability/tracing";

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
    funding: "openai_credit" | "paid",
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
  fetchFor: (metadata, observers, funding) =>
    gatewayFetch("openai", {
      ...cachedCall({ metadata }),
      ...observers,
      funding,
    }),
  configured: gatewayConfigured,
  vectorStore: productionVectorStore,
  config: getSemanticEmbeddingConfig,
};

const queryEmbeddingCache = new LRUCache<string, number[]>({
  max: 500,
  ttl: 1000 * 60 * 60,
});
/** Concurrent callers of one query share its provider call, as cached ones do. */
const pendingQueryEmbeddings = new Map<string, Promise<number[] | null>>();

/**
 * The one gate every semantic consumer asks. An embedding is only useful if
 * there is somewhere to store and search it: a runtime that reaches the
 * gateway without the Vectorize binding must not report "configured", or the
 * Problems detector flags the whole corpus as missing with no way to clear it.
 */
export function semanticEmbeddingsConfigured(
  ports: EmbeddingPorts = productionEmbeddingPorts,
): boolean {
  return ports.configured() && ports.vectorStore.configured();
}

/**
 * One provider request for the array's uncached texts — the adapter batches
 * natively, so every miss comes back from a single call regardless of size.
 */
export async function embedTexts(
  texts: string[],
  opts?: {
    operation?: string;
    /** A durable refresh must execute the configuration it content-addressed. */
    config?: ReturnType<typeof getSemanticEmbeddingConfig>;
    db?: Database;
    /** The session this search belongs to. With no Run, nobody is assumed to be waiting. */
    runId?: RunId;
    interactive?: boolean;
    feature?: string;
    entity?: { entityKind: string; entityId: string };
  },
  ports: EmbeddingPorts = productionEmbeddingPorts,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!ports.configured()) {
    throw new Error(
      "Semantic embeddings are not configured: this runtime has no AI_GATEWAY_EGRESS binding.",
    );
  }
  const operation = opts?.operation ?? "embeddings";
  const feature = opts?.feature ?? SEMANTIC_QUERY_FEATURE.feature;

  return withTrace(TraceNames.api("embeddings", operation), async (span) => {
    const config = opts?.config ?? ports.config();
    span.setAttributes({
      "ai.provider": config.provider,
      "ai.model": config.model,
      "ai.dimensions": config.dimensions,
      "ai.input_count": texts.length,
    });
    const metadata: GatewayMetadata = { feature, operation };
    return runEmbeddingFeature(
      { feature, model: config.model },
      {
        texts,
        dimensions: config.dimensions,
        cache: ports === productionEmbeddingPorts,
        embed: async (batch, observers) => {
          // OpenAI credit first, then paid Unified Billing with no window
          // budget: embeddings are cheap and never wait while paid can answer.
          const request = (funding: "openai_credit" | "paid") =>
            ports.fetchFor(
              metadata,
              observers,
              funding,
            )(`${gatewayBaseURL("openai")}/embeddings`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: config.model,
                input: batch,
                dimensions: config.dimensions,
              }),
            });
          let funding: "openai_credit" | "paid" = "openai_credit";
          let response = await request(funding);
          if (!response.ok) {
            const body = await response.clone().text();
            if (
              classifyFundingRefusal({
                status: response.status,
                text: body,
                funding,
              })
            ) {
              funding = "paid";
              response = await request(funding);
            }
          }
          if (!response.ok) {
            const body = await response.text();
            const failure = `Embeddings request failed (HTTP ${response.status} ${response.statusText}): ${body}`;
            if (funding === "paid" && paidFundingRefusal(body)) {
              // A member's search fails readably; background work waits for funding.
              if (opts?.interactive)
                throw new Error(
                  `Semantic search is unavailable: OpenAI credit and paid AI are both unavailable. ${failure}`,
                );
              throw new JobDeferredError(
                failure,
                fundingResumeAt(),
                "ai_funding_window",
              );
            }
            throw new Error(failure);
          }
          const json: unknown = await response.json();
          // Paid `/ai/run` wraps the provider answer in `result`.
          const body = embeddingsResponseSchema.parse(
            funding === "paid" &&
              json &&
              typeof json === "object" &&
              "result" in json
              ? json.result
              : json,
          );
          return {
            ...(ports === productionEmbeddingPorts &&
              funding === "openai_credit" && {
                costEvidence: {
                  standard: null,
                  charged: null,
                  billingReason: "subscriber_credit" as const,
                },
              }),
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
      {
        db: opts?.db,
        runId: opts?.runId,
        interactive: opts?.interactive,
        operation,
        entity: opts?.entity,
      },
    );
  });
}

export async function embedQuery(
  query: string,
  opts?: { db?: Database; runId?: RunId; interactive?: boolean },
): Promise<number[] | null> {
  if (!semanticEmbeddingsConfigured()) return null;
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized) return null;
  const cached = queryEmbeddingCache.get(normalized);
  if (cached) return cached;
  // A provider-free preparation (a settled-suggestion recheck) must not pay
  // for an embedding; its prepared inputs are incomplete instead.
  if (preparingWithoutProviders()) {
    markPreparationIncomplete();
    return null;
  }
  const pending = pendingQueryEmbeddings.get(normalized);
  if (pending) return pending;
  const request = embedTexts([normalized], {
    operation: "queryEmbedding",
    db: opts?.db,
    runId: opts?.runId,
    interactive: opts?.interactive,
    feature: SEMANTIC_QUERY_FEATURE.feature,
  })
    .then(([embedding]) => {
      if (embedding) queryEmbeddingCache.set(normalized, embedding);
      return embedding ?? null;
    })
    .finally(() => pendingQueryEmbeddings.delete(normalized));
  pendingQueryEmbeddings.set(normalized, request);
  return request;
}
