import type { EmbeddingReadiness } from "@cubby/schemas/relatedness";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { entityEmbedding } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { getSearchDocumentEmbeddingText } from "~/server/repo/search-document";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";
import { embeddingTextHash } from "~/server/semantic/hash";
import { normalizeSearchText } from "~/server/semantic/text";
import type {
  VectorMatch,
  VectorStorePort,
} from "~/server/semantic/vector-store";

/** Same shape as {@link VectorMatch}; aliased so repo callers don't import the store's type directly. */
export type EntityEmbeddingCandidate = VectorMatch;

/** Compare one entity's current document text to its configured stored vector. */
export async function getEntityEmbeddingReadiness(
  db: Database,
  ref: SearchableEntityRef,
  config: SemanticEmbeddingConfig,
): Promise<Exclude<EmbeddingReadiness, "unavailable">> {
  const [document, embedding] = await Promise.all([
    getSearchDocumentEmbeddingText(db, ref.entityType, ref.entityId),
    getDb(db).query.entityEmbedding.findFirst({
      where: and(
        eq(entityEmbedding.entityType, ref.entityType),
        eq(entityEmbedding.entityId, ref.entityId),
        eq(entityEmbedding.provider, config.provider),
        eq(entityEmbedding.model, config.model),
        eq(entityEmbedding.dimensions, config.dimensions),
        notDeleted(entityEmbedding),
      ),
      columns: { embeddingHash: true },
    }),
  ]);
  if (!document || !embedding) return "uncomputed";
  const expectedHash = await embeddingTextHash({
    entityType: ref.entityType,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    text: normalizeSearchText(document.embeddingText),
  });
  return embedding.embeddingHash === expectedHash ? "ready" : "stale";
}

/** Ranked nearest neighbours for an arbitrary query vector. */
export async function findSemanticEntityCandidates(
  vectorStore: VectorStorePort,
  queryEmbedding: number[],
  opts: { entityTypes?: SearchableEntity[]; limit: number },
): Promise<EntityEmbeddingCandidate[]> {
  return vectorStore.query(queryEmbedding, {
    entityTypes: opts.entityTypes,
    topK: opts.limit,
  });
}

/**
 * Entity-to-entity nearest neighbours: looks the seed vector up by id and
 * reuses it as the query vector in one round trip.
 *
 * +1 on `topK` so the seed itself (always its own nearest neighbour when
 * source and target types match) can be dropped without shrinking the result
 * set below `opts.limit`. The in-memory test fake returns the seed as a match
 * (score 1); the real index may too, so this filter is load-bearing, not
 * defensive-only.
 *
 * Returns `[]` when the seed has no vector yet (never embedded).
 */
export async function findSimilarEntities(
  vectorStore: VectorStorePort,
  seed: SearchableEntityRef,
  opts: { targetType: SearchableEntity; limit: number },
): Promise<EntityEmbeddingCandidate[]> {
  const candidates = await vectorStore.queryById(seed, {
    entityTypes: [opts.targetType],
    topK: opts.limit + 1,
  });

  return candidates
    .filter(
      (candidate) =>
        !(
          candidate.entityType === seed.entityType &&
          candidate.entityId === seed.entityId
        ),
    )
    .slice(0, opts.limit);
}
