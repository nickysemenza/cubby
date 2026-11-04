import type { RunId } from "@cubby/schemas/identifiers";
import type { SearchableEntity, SearchHit } from "@cubby/schemas/search";
import { getErrorMessage } from "@cubby/shared";
import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db";
import {
  findSemanticEntityCandidates,
  type SemanticCoverageGap,
} from "~/server/generic/embedding/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { SEMANTIC_MIN_QUERY_LENGTH } from "~/server/generic/embedding/service/semantic/constants";
import {
  embedQuery,
  semanticEmbeddingsConfigured,
} from "~/server/generic/embedding/service/semantic/embeddings";
import { productionVectorStore } from "~/server/generic/embedding/service/semantic/vector-store";
import { hydrateSearchHitRefs } from "~/server/generic/search/service/search.service";
import { TraceNames, withTrace } from "~/server/observability/tracing";

const log = createLogger("semantic-search");

export interface SemanticProductCandidate {
  item: SearchHit & { entityId: string; name: string };
  similarity: number;
  reason: string;
}

export interface SemanticProductCandidateScan {
  candidates: SemanticProductCandidate[];
  complete: boolean;
  error?: string;
  /** Absent on an incomplete scan when a provider failed instead. */
  gap?: SemanticCoverageGap;
}

const COVERAGE_GAP_ERROR = {
  pending: "Semantic candidate coverage is pending",
  budget_exceeded:
    "Semantic candidate coverage exceeded its fixed candidate budget",
} satisfies Record<SemanticCoverageGap, string>;

async function semanticSearchCandidates(
  db: Database,
  query: string,
  limit: number,
  entityKinds: SearchableEntity[],
  runId?: RunId,
): Promise<SemanticProductCandidateScan> {
  if (query.trim().length < SEMANTIC_MIN_QUERY_LENGTH)
    return { candidates: [], complete: true };
  if (!semanticEmbeddingsConfigured())
    return {
      candidates: [],
      complete: false,
      error: "Semantic embeddings are unavailable",
    };

  const config = getSemanticEmbeddingConfig();
  const embedding = await withTrace(
    TraceNames.service("semanticSearch", "embedQuery"),
    () => embedQuery(query, { db, runId }),
  );
  if (!embedding)
    return {
      candidates: [],
      complete: false,
      error: "Query embedding is unavailable",
    };

  const scan = await withTrace(
    TraceNames.service("semanticSearch", "vectorLookup"),
    () =>
      findSemanticEntityCandidates(db, productionVectorStore, embedding, {
        entityKinds,
        limit,
        config,
      }),
  );
  const refs = scan.candidates;
  const hits = await hydrateSearchHitRefs(db, refs);
  const hitByRef = new Map(
    hits.map((hit) => [`${hit.entityKind}:${hit.entityId}`, hit] as const),
  );
  const candidates = refs.flatMap((ref) => {
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
  return {
    candidates,
    complete: scan.complete,
    ...(scan.gap ? { error: COVERAGE_GAP_ERROR[scan.gap], gap: scan.gap } : {}),
  };
}

/** Unconfirmed coverage withholds negatives; valid candidates remain usable. */
export async function semanticEntityCandidateScan(
  db: Database,
  query: string,
  limit: number,
  entityKind: SearchableEntity,
  runId?: RunId,
): Promise<SemanticProductCandidateScan> {
  try {
    return await semanticSearchCandidates(
      db,
      query,
      limit,
      [entityKind],
      runId,
    );
  } catch (error) {
    return { candidates: [], complete: false, error: getErrorMessage(error) };
  }
}

/** Internal semantic fallback for candidate matching; never used by global UX. */
export async function semanticEntityCandidates(
  db: Database,
  query: string,
  limit: number,
  entityKind: SearchableEntity,
  runId?: RunId,
): Promise<SemanticProductCandidate[]> {
  try {
    const scan = await semanticSearchCandidates(
      db,
      query,
      limit,
      [entityKind],
      runId,
    );
    return scan.candidates;
  } catch (error) {
    log.warn(`${entityKind}-candidates failed`, {
      query,
      message: getErrorMessage(error),
    });
    return [];
  }
}

export const semanticProductCandidates = (
  db: Database,
  query: string,
  limit: number,
  runId?: RunId,
): Promise<SemanticProductCandidate[]> =>
  semanticEntityCandidates(db, query, limit, "product", runId);
