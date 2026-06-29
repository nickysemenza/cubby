import type { EnqueueEmbeddingBackfillOut } from "@cubby/schemas/background-jobs";
import type {
  SearchableEntity,
  SearchDebugOut,
  SearchResultItem,
} from "@cubby/schemas/search";
import { getErrorMessage } from "~/lib/error-utils";
import { dispatchBackgroundJobs } from "~/server/background-queue";
import type { Database } from "~/server/db";
import {
  findSemanticEntityCandidates,
  getEmbeddingTextsForEntityTypes,
  getStaleEmbeddingTextsForEntityTypes,
  upsertEntityEmbedding,
} from "~/server/repo/entity-embedding";
import { globalSearch, hydrateSearchResultsByRefs } from "~/server/repo/search";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import {
  SEMANTIC_BACKFILL_BATCH_SIZE,
  SEMANTIC_MIN_QUERY_LENGTH,
} from "~/server/semantic/constants";
import {
  embedQuery,
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import {
  explainSemanticCandidate,
  mergeHybridSearchResults,
  type SemanticCandidate,
} from "~/server/semantic/ranking";
import { TraceNames, withTrace } from "~/server/tracing";

const ALL_SEARCHABLE_ENTITIES: SearchableEntity[] = [
  "product",
  "recipe",
  "ingredient",
  "location",
  "inventory",
];

async function semanticSearchCandidates(
  db: Database,
  query: string,
  limit: number,
  entityTypes?: SearchableEntity[],
): Promise<SemanticCandidate[]> {
  if (query.trim().length < SEMANTIC_MIN_QUERY_LENGTH) return [];
  if (!semanticEmbeddingsConfigured()) return [];

  try {
    const config = getSemanticEmbeddingConfig();
    const embedding = await embedQuery(query, { db });
    if (!embedding) return [];

    const refs = await findSemanticEntityCandidates(db, embedding, config, {
      entityTypes,
      limit: limit * 3,
    });
    if (refs.length === 0) return [];

    const items = await hydrateSearchResultsByRefs(
      db,
      refs.map((ref) => ({
        entityType: ref.entityType,
        entityId: ref.entityId,
      })),
    );
    const itemByKey = new Map(
      items.map((item) => [`${item.entityType}:${item.id}`, item] as const),
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

export async function hybridGlobalSearch(
  db: Database,
  query: string,
  limit: number,
): Promise<SearchResultItem[]> {
  return withTrace(
    TraceNames.service("semanticSearch", "global"),
    async (span) => {
      // Independent I/O — run the lexical DB fan-out and the semantic
      // (embed + vector) path concurrently.
      const [lexical, semantic] = await Promise.all([
        globalSearch(db, query, limit),
        semanticSearchCandidates(db, query, limit),
      ]);
      // Keep unified score ranking, but cap the merged list generously (room for
      // ~`limit` of each entity type) so a low-scoring category isn't crowded out
      // of a flat result list by one dominant type.
      const mergedLimit = limit * ALL_SEARCHABLE_ENTITIES.length;
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
): Promise<SearchDebugOut> {
  const lexical = await globalSearch(db, query, limit);
  const semantic = await semanticSearchCandidates(db, query, limit);
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

export async function backfillEntityEmbeddings(
  db: Database,
  opts: { entityTypes?: SearchableEntity[]; limit: number },
): Promise<{ scanned: number; embedded: number; skipped: number }> {
  if (!semanticEmbeddingsConfigured()) {
    return { scanned: 0, embedded: 0, skipped: opts.limit };
  }
  const config = getSemanticEmbeddingConfig();
  const entityTypes = opts.entityTypes?.length
    ? opts.entityTypes
    : ALL_SEARCHABLE_ENTITIES;
  const rows = await getEmbeddingTextsForEntityTypes(
    db,
    entityTypes,
    opts.limit,
  );
  let embedded = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += SEMANTIC_BACKFILL_BATCH_SIZE) {
    const batch = rows.slice(i, i + SEMANTIC_BACKFILL_BATCH_SIZE);
    const embeddings = await embedTexts(
      batch.map((row) => row.embeddingText),
      { operation: "entityEmbeddingBackfill", db, feature: "entity-embedding" },
    );
    await Promise.all(
      batch.map(async (row, index) => {
        const embedding = embeddings[index];
        if (!embedding) {
          skipped += 1;
          return;
        }
        await upsertEntityEmbedding(db, {
          ...row,
          config,
          embedding,
        });
        embedded += 1;
      }),
    );
  }

  return { scanned: rows.length, embedded, skipped };
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

export async function semanticProductCandidates(
  db: Database,
  query: string,
  limit: number,
): Promise<SemanticCandidate[]> {
  return semanticSearchCandidates(db, query, limit, ["product"]);
}
