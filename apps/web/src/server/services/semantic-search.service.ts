import {
  type EnqueueEmbeddingBackfillOut,
  entityEmbeddingBackfillCoordinatorPayloadSchema,
} from "@cubby/schemas/background-jobs";
import type {
  RequestEmbeddingRefreshInput,
  RequestEmbeddingRefreshOut,
  SearchableEntity,
  SearchHit,
  SimilarEntitiesInput,
  SimilarEntitiesOut,
} from "@cubby/schemas/search";
import { searchableEntities, similarEntityPairs } from "@cubby/schemas/search";
import type { z } from "zod";

import { getErrorMessage } from "~/lib/error-utils";
import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import {
  continueWorkflow,
  startOrReuseWorkflow,
} from "~/server/background-workflow";
import type { Database } from "~/server/db";
import {
  findSemanticEntityCandidates,
  findSimilarEntities,
} from "~/server/repo/entity-embedding";
import { getStaleSearchDocumentEmbeddingTextPage } from "~/server/repo/search-document";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { SEMANTIC_MIN_QUERY_LENGTH } from "~/server/semantic/constants";
import {
  embedQuery,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import { hydrateSearchHitRefs } from "~/server/services/search.service";
import { TraceNames, withTrace } from "~/server/tracing";

import { getEmbeddingReadiness } from "./embedding-readiness.service";

const ALL_SEARCHABLE_ENTITIES: SearchableEntity[] = [...searchableEntities];

type SemanticBackfillWorkflowMetadata = z.output<
  typeof entityEmbeddingBackfillCoordinatorPayloadSchema
>;
type SemanticBackfillWorkflowMetadataInput = z.input<
  typeof entityEmbeddingBackfillCoordinatorPayloadSchema
>;

export interface SemanticProductCandidate {
  item: SearchHit & { entityId: string; name: string };
  similarity: number;
  reason: string;
}

async function semanticSearchCandidates(
  db: Database,
  query: string,
  limit: number,
  entityTypes: SearchableEntity[],
): Promise<SemanticProductCandidate[]> {
  if (query.trim().length < SEMANTIC_MIN_QUERY_LENGTH) return [];
  if (!semanticEmbeddingsConfigured()) return [];

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
        limit,
      }),
  );
  const hits = await hydrateSearchHitRefs(db, refs);
  const hitByRef = new Map(
    hits.map((hit) => [`${hit.entityType}:${hit.entityId}`, hit] as const),
  );
  return refs.flatMap((ref) => {
    const hit = hitByRef.get(`${ref.entityType}:${ref.entityId}`);
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

export async function enqueueEntityEmbeddingBackfill(
  db: Database,
  opts: { entityTypes?: SearchableEntity[] },
): Promise<EnqueueEmbeddingBackfillOut> {
  const entityTypes = [
    ...new Set(
      opts.entityTypes?.length ? opts.entityTypes : ALL_SEARCHABLE_ENTITIES,
    ),
  ].sort();
  const workflow = await startOrReuseWorkflow(db, {
    kind: "entity-embedding.backfill.coordinator",
    source: "backfill",
    dedupeKey: `semantic-backfill:${entityTypes.join(",")}`,
    metadata: {
      source: "search.debug.semanticBackfill",
      workflow: {
        type: "entity-embedding.backfill.coordinator",
        entityTypes,
        cursor: null,
        pagesCompleted: 0,
        jobsQueued: 0,
        state: "active",
      },
    } satisfies SemanticBackfillWorkflowMetadataInput,
    initialJobs: [
      {
        kind: "entity-embedding.backfill.coordinator",
        dedupeKey: `semantic-backfill:${entityTypes.join(",")}:page:0`,
        payload: {
          source: "search.debug.semanticBackfill",
          workflow: {
            type: "entity-embedding.backfill.coordinator",
            entityTypes,
            cursor: null,
            pagesCompleted: 0,
            jobsQueued: 0,
            state: "active",
          },
        } satisfies SemanticBackfillWorkflowMetadataInput,
      },
    ],
  });
  return { batch: workflow.batch, reused: workflow.reused };
}

/** Process one bounded semantic-backfill page inside its coordinator job. */
export async function continueEntityEmbeddingBackfillWorkflow(
  db: Database,
  batchId: string,
  metadata: SemanticBackfillWorkflowMetadata,
): Promise<"succeeded" | "skipped"> {
  if (metadata.workflow.state === "complete") return "skipped";
  const page = await getStaleSearchDocumentEmbeddingTextPage(
    db,
    metadata.workflow.entityTypes,
    getSemanticEmbeddingConfig(),
    {
      cursor: metadata.workflow.cursor ? metadata.workflow.cursor : undefined,
    },
  );
  const nextMetadata: SemanticBackfillWorkflowMetadataInput = {
    ...metadata,
    workflow: {
      ...metadata.workflow,
      cursor: page.nextCursor,
      pagesCompleted: metadata.workflow.pagesCompleted + 1,
      jobsQueued: metadata.workflow.jobsQueued + page.rows.length,
      state: page.nextCursor ? "active" : "complete",
    },
  };
  await continueWorkflow(db, {
    batchId,
    batchKind: "entity-embedding.backfill.coordinator",
    metadata: nextMetadata,
    children: page.rows.map((row) => ({
      kind: "entity-embedding.refresh",
      dedupeKey: `entity-embedding.refresh:${row.entityType}:${row.entityId}:${row.expectedEmbeddingHash}`,
      payload: {
        entityType: row.entityType,
        entityId: row.entityId,
        expectedEmbeddingHash: row.expectedEmbeddingHash,
      },
    })),
    continuation: page.nextCursor
      ? {
          kind: "entity-embedding.backfill.coordinator",
          dedupeKey: `workflow:${batchId}:page:${metadata.workflow.pagesCompleted + 1}`,
          payload: nextMetadata,
        }
      : null,
  });
  return "succeeded";
}

/** Queue one resolved entity, rather than sampling the global stale worklist. */
export async function requestEmbeddingRefresh(
  db: Database,
  input: RequestEmbeddingRefreshInput,
): Promise<RequestEmbeddingRefreshOut> {
  const entityId = await resolveOrThrow(db, input.entityType, input.entityId);
  const dispatched = await dispatchBackgroundJobs(db, {
    kind: "entity-embedding.refresh",
    source: "ui",
    metadata: { source: "relatedness.indexNow", entityType: input.entityType },
    jobs: [
      {
        kind: "entity-embedding.refresh" as const,
        dedupeKey: `entity-embedding.refresh:${input.entityType}:${entityId}`,
        payload: { entityType: input.entityType, entityId },
      },
    ],
  });
  return { batchId: dispatched.batchId, totalJobs: dispatched.jobIds.length };
}

/** Entity-to-entity similarity remains an explicit semantic interaction. */
export async function findSimilarEntitiesForPair(
  db: Database,
  input: SimilarEntitiesInput,
): Promise<SimilarEntitiesOut> {
  const pair = similarEntityPairs[input.pair];
  if (!pair) {
    throw new Error(`Unsupported relatedness pair: ${input.pair}`);
  }
  const { source, target } = pair;
  const sourceEntityId = await resolveOrThrow(db, source, input.sourceId);
  const sourceRef = { entityType: source, entityId: sourceEntityId };
  const publicSource = { entityType: source, entityId: input.sourceId };
  const status = await getEmbeddingReadiness(db, sourceRef);
  const empty: SimilarEntitiesOut = {
    source: publicSource,
    status,
    results: [],
  };
  if (status !== "ready") return empty;

  const candidates = await findSimilarEntities(
    db,
    sourceRef,
    getSemanticEmbeddingConfig(),
    { targetType: target, limit: input.limit },
  );
  const hits = await hydrateSearchHitRefs(db, candidates);
  const hitByRef = new Map(
    hits.map((hit) => [`${hit.entityType}:${hit.entityId}`, hit] as const),
  );
  return {
    source: publicSource,
    status,
    results: candidates.flatMap((candidate) => {
      const hit = hitByRef.get(`${candidate.entityType}:${candidate.entityId}`);
      if (!hit) return [];
      const { entityId: _privateEntityId, ...entity } = hit;
      return [{ similarity: candidate.similarity, entity }];
    }),
  };
}

/** Internal semantic fallback for product matching; never used by global UX. */
export async function semanticProductCandidates(
  db: Database,
  query: string,
  limit: number,
): Promise<SemanticProductCandidate[]> {
  try {
    return await semanticSearchCandidates(db, query, limit, ["product"]);
  } catch (error) {
    console.warn("semantic.product-candidates.failed", {
      query,
      message: getErrorMessage(error),
    });
    return [];
  }
}
