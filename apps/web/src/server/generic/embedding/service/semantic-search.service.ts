import type {
  SearchableEntity,
  SearchHit,
  SemanticCoverageGap,
} from "@cubby/schemas/search";
import { getErrorMessage } from "@cubby/shared";
import { createLogger } from "@cubby/worker-tracing";

import { type AiCallOwner } from "~/server/ai/policy/call-owner";
import type { Database } from "~/server/db";
import {
  findSemanticEntityCandidates,
  type SemanticCandidateScan,
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

/** Ranked refs and their coverage, before any canonical row is read. */
interface SemanticRefScan extends SemanticCandidateScan {
  error?: string;
}

type SemanticRef = SemanticRefScan["candidates"][number];

const COVERAGE_GAP_ERROR = {
  pending: "Semantic candidate coverage is pending",
  budget_exceeded:
    "Semantic candidate coverage exceeded its fixed candidate budget",
} satisfies Record<SemanticCoverageGap, string>;

async function scanSemanticRefs(
  db: Database,
  query: string,
  limit: number,
  entityKind: SearchableEntity,
  owner?: AiCallOwner,
): Promise<SemanticRefScan> {
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
    () => embedQuery(query, { db, ...owner }),
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
        entityKinds: [entityKind],
        limit,
        config,
      }),
  );
  return {
    candidates: scan.candidates,
    complete: scan.complete,
    ...(scan.gap ? { error: COVERAGE_GAP_ERROR[scan.gap], gap: scan.gap } : {}),
  };
}

/** Rejoins rows to ranked refs; a ref with no live row drops out. */
function rankRowsByRef<Row extends { entityKind: string; entityId: string }>(
  refs: readonly SemanticRef[],
  rows: readonly Row[],
): { row: Row; similarity: number }[] {
  const rowByRef = new Map(
    rows.map((row) => [`${row.entityKind}:${row.entityId}`, row] as const),
  );
  return refs.flatMap((ref) => {
    const row = rowByRef.get(`${ref.entityKind}:${ref.entityId}`);
    return row ? [{ row, similarity: ref.similarity }] : [];
  });
}

/** Internal semantic fallback for candidate matching; never used by global UX. */
export async function semanticEntityCandidates(
  db: Database,
  query: string,
  limit: number,
  entityKind: SearchableEntity,
  owner?: AiCallOwner,
): Promise<SemanticProductCandidate[]> {
  try {
    const { candidates: refs } = await scanSemanticRefs(
      db,
      query,
      limit,
      entityKind,
      owner,
    );
    const hits = await hydrateSearchHitRefs(db, refs);
    const { provider, model } = getSemanticEmbeddingConfig();
    return rankRowsByRef(refs, hits).map(({ row: hit, similarity }) => ({
      item: { ...hit, name: hit.title },
      similarity,
      reason: `Semantic ${provider}/${model}`,
    }));
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
  owner?: AiCallOwner,
): Promise<SemanticProductCandidate[]> =>
  semanticEntityCandidates(db, query, limit, "product", owner);
