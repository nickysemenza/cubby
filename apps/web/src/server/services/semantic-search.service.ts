import { createLogger } from "@cubby/worker-tracing";
import type { RunId } from "@cubby/schemas/identifiers";
import type { SearchableEntity, SearchHit } from "@cubby/schemas/search";

import { getErrorMessage } from "~/lib/error-utils";
import type { Database } from "~/server/db";
import { findSemanticEntityCandidates } from "~/server/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { SEMANTIC_MIN_QUERY_LENGTH } from "~/server/semantic/constants";
import {
  embedQuery,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import { productionVectorStore } from "~/server/semantic/vector-store";
import { hydrateSearchHitRefs } from "~/server/services/search.service";
import { TraceNames, withTrace } from "~/server/tracing";

const log = createLogger("semantic-search");

export interface SemanticProductCandidate {
  item: SearchHit & { entityId: string; name: string };
  similarity: number;
  reason: string;
}

async function semanticSearchCandidates(
  db: Database,
  query: string,
  limit: number,
  entityKinds: SearchableEntity[],
  runId?: RunId,
): Promise<SemanticProductCandidate[]> {
  if (query.trim().length < SEMANTIC_MIN_QUERY_LENGTH) return [];
  if (!semanticEmbeddingsConfigured()) return [];

  const config = getSemanticEmbeddingConfig();
  const embedding = await withTrace(
    TraceNames.service("semanticSearch", "embedQuery"),
    () => embedQuery(query, { db, runId }),
  );
  if (!embedding) return [];

  const refs = await withTrace(
    TraceNames.service("semanticSearch", "vectorLookup"),
    () =>
      findSemanticEntityCandidates(productionVectorStore, embedding, {
        entityKinds,
        limit,
      }),
  );
  const hits = await hydrateSearchHitRefs(db, refs);
  const hitByRef = new Map(
    hits.map((hit) => [`${hit.entityKind}:${hit.entityId}`, hit] as const),
  );
  return refs.flatMap((ref) => {
    const hit = hitByRef.get(`${ref.entityKind}:${ref.entityId}`);
    return hit
      ? [
          {
            item: { ...hit, name: hit.title },
            similarity: ref.similarity,
            reason: `Semantic ${config.provider}/${config.model}`,
          },
        ]
      : [];
  });
}

/** Internal semantic fallback for product matching; never used by global UX. */
export async function semanticProductCandidates(
  db: Database,
  query: string,
  limit: number,
  runId?: RunId,
): Promise<SemanticProductCandidate[]> {
  try {
    return await semanticSearchCandidates(db, query, limit, ["product"], runId);
  } catch (error) {
    log.warn("product-candidates failed", {
      query,
      message: getErrorMessage(error),
    });
    return [];
  }
}
