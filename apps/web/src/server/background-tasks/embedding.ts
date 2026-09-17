import {
  isEmbeddableEntity,
  type SearchableEntity,
} from "@cubby/schemas/search";

import type { Database } from "~/server/db";
import {
  getStoredEmbeddingHash,
  upsertEntityEmbeddingIfCurrent,
} from "~/server/repo/entity-embedding-refresh";
import {
  getSearchDocumentEmbeddingText,
  refreshSearchDocument,
} from "~/server/repo/search-document";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import {
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/semantic/embeddings";
import { embeddingTextHash } from "~/server/semantic/hash";
import { normalizeSearchText } from "~/server/semantic/text";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/semantic/vector-store";

/**
 * The embedding provider and the vector store are the genuinely external
 * seams in this pipeline; tests substitute them and nothing else.
 */
export interface EmbeddingRefreshPort {
  readonly configured: () => boolean;
  readonly embed: typeof embedTexts;
  readonly config: typeof getSemanticEmbeddingConfig;
  readonly vectorStore: VectorStorePort;
}

export const productionEmbeddingRefreshPort: EmbeddingRefreshPort = {
  configured: semanticEmbeddingsConfigured,
  embed: embedTexts,
  config: getSemanticEmbeddingConfig,
  vectorStore: productionVectorStore,
};

export type EmbeddingRefreshOutcome =
  /** A vector for the current projection was stored. */
  | "written"
  /** The stored vector already matches the current projection. */
  | "fresh"
  /** No live document: the entity is gone or was never projected. */
  | "missing"
  /** The projection kept changing across every retry; not retried further. */
  | "obsolete"
  /** No provider credentials in this environment. */
  | "unconfigured"
  /** Searchable but excluded from embedding (the financial entities). */
  | "notEmbeddable";

/**
 * Bounds the obsolete-projection repair loop below. One extra attempt beyond
 * the first covers the ordinary race (this refresh's own vector upsert
 * clobbering a concurrent writer's fresher one, see below); it is not meant
 * to converge an entity under continuous rewrite.
 */
const MAX_EMBED_ATTEMPTS = 3;

/**
 * Bring one entity's vector up to date with its current search document.
 *
 * Idempotent by construction: the projection is refreshed first, the stored
 * hash is compared before the provider is paid, and the write is conditional
 * on the projection still being current. Duplicate or out-of-order deliveries
 * therefore cost at most one cheap read.
 */
export async function refreshEntityEmbedding(
  db: Database,
  ref: { entityType: SearchableEntity; entityId: string },
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
): Promise<EmbeddingRefreshOutcome> {
  const refreshed = await refreshSearchDocument(
    db,
    ref.entityType,
    ref.entityId,
  );
  if (refreshed.status !== "upserted") return "missing";

  // The lexical SearchDocument projection above runs for every searchable
  // type, financial entities included (see `search-document.ts`
  // `getSearchDocumentSources`); only `isEmbeddableEntity` types get a
  // vector, so this check comes after the projection refresh, not before it.
  if (!isEmbeddableEntity(ref.entityType)) return "notEmbeddable";

  const config = port.config();
  let text = await getSearchDocumentEmbeddingText(
    db,
    ref.entityType,
    ref.entityId,
  );
  if (!text) return "missing";

  const embeddingHash = await embeddingTextHash({
    entityType: text.entityType,
    provider: config.provider,
    model: config.model,
    dimensions: config.dimensions,
    text: normalizeSearchText(text.embeddingText),
  });
  const stored = await getStoredEmbeddingHash(db, {
    entityType: text.entityType,
    entityId: text.entityId,
    config,
  });
  if (stored === embeddingHash) return "fresh";
  if (!port.configured()) return "unconfigured";

  // Only the first attempt reuses the hash/text pair the gate above already
  // checked; every retry below re-derives both from the CURRENT projection —
  // no freshness short-circuit — because the point of retrying is to land a
  // vector for whatever text is live now, not to discover it already matches
  // and skip repairing the vector store (see the "obsolete" branch comment).
  let currentHash = embeddingHash;
  for (let attempt = 0; attempt < MAX_EMBED_ATTEMPTS; attempt += 1) {
    const [embedding] = await port.embed([text.embeddingText], {
      operation: "entityEmbeddingRefresh",
      db,
      feature: "entity-embedding",
      entity: { entityType: text.entityType, entityId: text.entityId },
    });
    if (!embedding) return "obsolete";

    // The vector store is written BEFORE the Postgres bookkeeping row: a
    // crash between the two calls leaves the entity "missing" (no
    // EntityEmbedding row at all), which a later refresh repairs, rather than
    // "ready" with a hash row pointing at a vector that was never stored.
    await port.vectorStore.upsert([
      {
        entityType: text.entityType,
        entityId: text.entityId,
        values: embedding,
      },
    ]);
    const outcome = await upsertEntityEmbeddingIfCurrent(db, {
      ...text,
      embeddingHash: currentHash,
      config,
    });
    if (outcome === "written") return "written";

    // "obsolete": the projection changed between embedding and persistence,
    // so the row above was not written for the text we just embedded. Our
    // vector-store upsert already landed, though, and may have clobbered a
    // concurrent writer's fresher vector with our now-stale one. Re-reading
    // the CURRENT text, re-embedding it, and looping repairs that clobber
    // ourselves (bounded by `MAX_EMBED_ATTEMPTS`) instead of leaving the
    // vector store permanently behind Postgres until some unrelated write
    // happens to touch this entity again.
    const current = await getSearchDocumentEmbeddingText(
      db,
      ref.entityType,
      ref.entityId,
    );
    if (!current) {
      await port.vectorStore.deleteByIds([
        { entityType: ref.entityType, entityId: ref.entityId },
      ]);
      return "obsolete";
    }
    text = current;
    currentHash = await embeddingTextHash({
      entityType: text.entityType,
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text: normalizeSearchText(text.embeddingText),
    });
  }
  return "obsolete";
}
