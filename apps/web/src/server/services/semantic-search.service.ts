import type { EnqueueEmbeddingBackfillOut } from "@cubby/schemas/background-jobs";
import type {
  SearchableEntity,
  SearchDebugOut,
  SearchResultItem,
  SimilarEntitiesInput,
  SimilarEntitiesOut,
} from "@cubby/schemas/search";
import { searchableEntities, similarEntityPairs } from "@cubby/schemas/search";
import { getErrorMessage } from "~/lib/error-utils";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import type { Database } from "~/server/db";
import {
  findSemanticEntityCandidates,
  findSimilarEntities,
  getStaleEmbeddingTextsForEntityTypes,
} from "~/server/repo/entity-embedding";
import {
  globalSearch,
  hydrateSearchResultsByRefs,
  type InternalSearchResult,
} from "~/server/repo/search";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { SEMANTIC_MIN_QUERY_LENGTH } from "~/server/semantic/constants";
import {
  embedQuery,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import {
  explainSemanticCandidate,
  mergeHybridSearchResults,
  type SemanticCandidate,
} from "~/server/semantic/ranking";
import { TraceNames, withTrace } from "~/server/tracing";

const ALL_SEARCHABLE_ENTITIES: SearchableEntity[] = [...searchableEntities];

async function semanticSearchCandidates(
  db: Database,
  query: string,
  limit: number,
  entityTypes?: SearchableEntity[],
): Promise<SemanticCandidate<InternalSearchResult>[]> {
  if (query.trim().length < SEMANTIC_MIN_QUERY_LENGTH) return [];
  if (!semanticEmbeddingsConfigured()) return [];

  try {
    const config = getSemanticEmbeddingConfig();
    const embedding = await withTrace(
      TraceNames.service("semanticSearch", "embedQuery"),
      () => embedQuery(query, { db }),
    );
    if (!embedding) return [];

    const refs = await withTrace(
      TraceNames.service("semanticSearch", "vectorLookup"),
      () =>
        findSemanticEntityCandidates(db, embedding, config, {
          entityTypes,
          limit: limit * 3,
        }),
    );
    if (refs.length === 0) return [];

    const items = await withTrace(
      TraceNames.service("semanticSearch", "hydrate"),
      () =>
        hydrateSearchResultsByRefs(
          db,
          refs.map((ref) => ({
            entityType: ref.entityType,
            entityId: ref.entityId,
          })),
        ),
    );
    const itemByKey = new Map(
      items.map(
        (item) => [`${item.entityType}:${item.entityId}`, item] as const,
      ),
    );

    return refs.flatMap((ref) => {
      const item = itemByKey.get(`${ref.entityType}:${ref.entityId}`);
      return item
        ? [
            {
              item,
              similarity: ref.similarity,
              reason: `Semantic ${config.provider}/${config.model}`,
            },
          ]
        : [];
    });
  } catch (error) {
    console.warn("semantic.search.failed", {
      query,
      entityTypes: entityTypes ?? null,
      errorName: error instanceof Error ? error.name : typeof error,
      message: getErrorMessage(error),
    });
    return [];
  }
}

/**
 * Lexical-only global search, ranked through the same hybrid merge (with an
 * empty semantic set) so results score and shape identically to
 * {@link hybridGlobalSearch}. This is the fast path — no embedding API call.
 */
export async function lexicalGlobalSearch(
  db: Database,
  query: string,
  limit: number,
  entityType?: SearchableEntity,
): Promise<SearchResultItem[]> {
  const entityTypes = entityType ? [entityType] : ALL_SEARCHABLE_ENTITIES;
  const lexical = await withTrace(
    TraceNames.service("semanticSearch", "lexicalFanout"),
    () => globalSearch(db, query, limit, entityTypes),
  );
  const mergedLimit = limit * entityTypes.length;
  return mergeHybridSearchResults(query, lexical, [], mergedLimit);
}

/**
 * Semantic-only global search. This intentionally avoids the lexical fan-out
 * so interactive callers can render lexical hits first, then append related
 * matches after the embedding request finishes.
 */
export async function semanticGlobalSearch(
  db: Database,
  query: string,
  limit: number,
  entityType?: SearchableEntity,
): Promise<SearchResultItem[]> {
  return withTrace(
    TraceNames.service("semanticSearch", "semanticOnly"),
    async (span) => {
      const entityTypes = entityType ? [entityType] : ALL_SEARCHABLE_ENTITIES;
      const semantic = await semanticSearchCandidates(
        db,
        query,
        limit,
        entityTypes,
      );
      const results = semantic.map((candidate) => {
        const explanation = explainSemanticCandidate(query, candidate);
        return {
          ...candidate.item,
          score: candidate.similarity,
          matchKind: "semantic" as const,
          matchReason: candidate.reason
            ? `${candidate.reason}; ${explanation.matchReason}`
            : explanation.matchReason,
          matchTerms: explanation.matchTerms,
        };
      });
      span.setAttributes({
        "search.semantic_count": semantic.length,
        "search.result_count": results.length,
      });
      return results;
    },
  );
}

export async function hybridGlobalSearch(
  db: Database,
  query: string,
  limit: number,
  entityType?: SearchableEntity,
): Promise<SearchResultItem[]> {
  return withTrace(
    TraceNames.service("semanticSearch", "global"),
    async (span) => {
      const entityTypes = entityType ? [entityType] : ALL_SEARCHABLE_ENTITIES;
      // Independent I/O — run the lexical DB fan-out and the semantic
      // (embed + vector) path concurrently.
      const [lexical, semantic] = await Promise.all([
        withTrace(TraceNames.service("semanticSearch", "lexicalFanout"), () =>
          globalSearch(db, query, limit, entityTypes),
        ),
        semanticSearchCandidates(db, query, limit, entityTypes),
      ]);
      // Keep unified score ranking, but cap the merged list generously (room for
      // ~`limit` of each entity type) so a low-scoring category isn't crowded out
      // of a flat result list by one dominant type.
      const mergedLimit = limit * entityTypes.length;
      const results = mergeHybridSearchResults(
        query,
        lexical,
        semantic,
        mergedLimit,
      );
      span.setAttributes({
        "search.lexical_count": lexical.length,
        "search.semantic_count": semantic.length,
        "search.result_count": results.length,
      });
      return results;
    },
  );
}

export async function debugHybridSearch(
  db: Database,
  query: string,
  limit: number,
  entityType?: SearchableEntity,
): Promise<SearchDebugOut> {
  const entityTypes = entityType ? [entityType] : ALL_SEARCHABLE_ENTITIES;
  const lexical = await globalSearch(db, query, limit, entityTypes);
  const semantic = await semanticSearchCandidates(
    db,
    query,
    limit,
    entityTypes,
  );
  return {
    query,
    lexical,
    semantic: semantic.map((candidate) => {
      const explanation = explainSemanticCandidate(query, candidate);
      return {
        ...candidate.item,
        score: candidate.similarity,
        matchKind: "semantic" as const,
        matchReason: candidate.reason
          ? `${candidate.reason}; ${explanation.matchReason}`
          : explanation.matchReason,
        matchTerms: explanation.matchTerms,
      };
    }),
    results: mergeHybridSearchResults(query, lexical, semantic, limit),
  };
}

export async function enqueueEntityEmbeddingBackfill(
  db: Database,
  opts: { entityTypes?: SearchableEntity[]; limit?: number },
): Promise<EnqueueEmbeddingBackfillOut> {
  const entityTypes = opts.entityTypes?.length
    ? opts.entityTypes
    : ALL_SEARCHABLE_ENTITIES;
  const config = getSemanticEmbeddingConfig();
  const rows = await getStaleEmbeddingTextsForEntityTypes(
    db,
    entityTypes,
    config,
    opts.limit,
  );
  const dispatched = await dispatchBackgroundJobs(db, {
    kind: "entity-embedding.refresh",
    source: "backfill",
    metadata: {
      source: "search.debug.semanticBackfill",
      entityTypes,
      limit: opts.limit ?? null,
      mode: "stale-or-missing",
    },
    jobs: rows.map((row) => ({
      kind: "entity-embedding.refresh" as const,
      dedupeKey: `entity-embedding.refresh:${row.entityType}:${row.entityId}`,
      payload: {
        entityType: row.entityType,
        entityId: row.entityId,
      },
    })),
  });
  return { batchId: dispatched.batchId, totalJobs: dispatched.jobIds.length };
}

/**
 * Entity-to-entity semantic similarity over the stored embeddings.
 *
 * Cross-cutting on three counts, which is what earns it a service rather than
 * a direct repo call from the router: it resolves the embedding-model config,
 * hops two repos (embedding nearest-neighbour → search hydration), and degrades
 * to an empty result when embeddings aren't configured at all.
 *
 * Unlike {@link semanticSearchCandidates} this does NOT swallow query errors —
 * there's no lexical half to fall back on, so a failed vector read must surface
 * rather than masquerade as "no similar entities".
 */
export async function findSimilarEntitiesForPair(
  db: Database,
  input: SimilarEntitiesInput,
): Promise<SimilarEntitiesOut> {
  const { source, target } = similarEntityPairs[input.pair];
  const sourceEntityId = await resolveOrThrow(db, source, input.sourceId);
  const sourceRef = { entityType: source, entityId: sourceEntityId };
  const publicSource = { entityType: source, entityId: input.sourceId };
  const empty: SimilarEntitiesOut = { source: publicSource, results: [] };

  if (!semanticEmbeddingsConfigured()) return empty;

  const config = getSemanticEmbeddingConfig();
  const candidates = await findSimilarEntities(db, sourceRef, config, {
    targetType: target,
    limit: input.limit,
  });
  if (candidates.length === 0) return empty;

  const items = await hydrateSearchResultsByRefs(
    db,
    candidates.map((candidate) => ({
      entityType: candidate.entityType,
      entityId: candidate.entityId,
    })),
  );
  const itemByKey = new Map(
    items.map((item) => [`${item.entityType}:${item.entityId}`, item] as const),
  );

  return {
    source: publicSource,
    results: candidates.flatMap((candidate) => {
      const item = itemByKey.get(
        `${candidate.entityType}:${candidate.entityId}`,
      );
      return item ? [{ similarity: candidate.similarity, entity: item }] : [];
    }),
  };
}

export async function semanticProductCandidates(
  db: Database,
  query: string,
  limit: number,
): Promise<SemanticCandidate<InternalSearchResult>[]> {
  return semanticSearchCandidates(db, query, limit, ["product"]);
}
