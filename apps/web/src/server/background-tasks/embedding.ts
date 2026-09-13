import type { SearchableEntity } from "@cubby/schemas/search";

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

/**
 * The embedding provider is the one genuinely external seam in this pipeline;
 * tests substitute it and nothing else.
 */
export interface EmbeddingRefreshPort {
  readonly configured: () => boolean;
  readonly embed: typeof embedTexts;
  readonly config: typeof getSemanticEmbeddingConfig;
}

export const productionEmbeddingRefreshPort: EmbeddingRefreshPort = {
  configured: semanticEmbeddingsConfigured,
  embed: embedTexts,
  config: getSemanticEmbeddingConfig,
};

export type EmbeddingRefreshOutcome =
  /** A vector for the current projection was stored. */
  | "written"
  /** The stored vector already matches the current projection. */
  | "fresh"
  /** No live document: the entity is gone or was never projected. */
  | "missing"
  /** The projection changed between embedding and persistence; not retried. */
  | "obsolete"
  /** No provider credentials in this environment. */
  | "unconfigured";

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
  const text = await getSearchDocumentEmbeddingText(
    db,
    ref.entityType,
    ref.entityId,
  );
  if (!text) return "missing";

  const config = port.config();
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

  const [embedding] = await port.embed([text.embeddingText], {
    operation: "entityEmbeddingRefresh",
    db,
    feature: "entity-embedding",
    entity: { entityType: text.entityType, entityId: text.entityId },
  });
  if (!embedding) return "obsolete";
  return await upsertEntityEmbeddingIfCurrent(db, {
    ...text,
    embeddingHash,
    config,
    embedding,
  });
}
