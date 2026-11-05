import { entityRefKey } from "@cubby/schemas/entity";
import type { SearchableEntityRef } from "@cubby/schemas/search";

import type { Database } from "~/server/db";
import { markEmbeddingRefresh } from "~/server/generic/embedding/repo/embedding-work";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/generic/embedding/service/semantic/embeddings";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { prepareSearchDocuments } from "~/server/generic/search/repo/search-document";

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

/** Owe one refresh per source identity; the drain reads current text and configuration. */
export async function enqueueEmbeddingRefs(
  db: Database,
  prepared: Awaited<ReturnType<typeof prepareSearchDocuments>>,
) {
  const refs = new Map<string, SearchableEntityRef>();
  for (const { source } of prepared.entries)
    refs.set(entityRefKey(source.entityKind, source.entityId), source);
  await markEmbeddingRefresh(
    db,
    [...refs.values()].map((ref) => ref.entityId),
  );
}
