import { entityRefKey } from "@cubby/schemas/entity";
import type { SearchableEntityRef } from "@cubby/schemas/search";

import type { Database } from "~/server/db";
import {
  EMBEDDING_REFRESH_DRAIN,
  EMBEDDING_REFRESH_TARGET,
} from "~/server/generic/embedding/repo/embedding-drain";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  embedTexts,
  semanticEmbeddingsConfigured,
} from "~/server/generic/embedding/service/semantic/embeddings";
import {
  productionVectorStore,
  type VectorStorePort,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { markWork } from "~/server/generic/jobs/repo/work-items";
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

export type EmbeddingRefreshResult = { outcome: "pending" | "unconfigured" };

/** Admit one refresh item per source identity; the drain reads current text and configuration. */
export async function enqueueEmbeddingRefs(
  db: Database,
  prepared: Awaited<ReturnType<typeof prepareSearchDocuments>>,
) {
  const refs = new Map<string, SearchableEntityRef>();
  for (const { source } of prepared.entries)
    refs.set(entityRefKey(source.entityKind, source.entityId), source);
  await markWork(
    db,
    EMBEDDING_REFRESH_DRAIN,
    [...refs.values()].map((ref) => ({
      target: EMBEDDING_REFRESH_TARGET,
      ref: ref.entityId,
    })),
  );
}

/** Explicit background refresh enters the same source-keyed drain as broad passes. */
export async function refreshEntityEmbeddings(
  db: Database,
  refs: readonly SearchableEntityRef[],
  port: EmbeddingRefreshPort = productionEmbeddingRefreshPort,
): Promise<Map<string, EmbeddingRefreshResult>> {
  const results = new Map<string, EmbeddingRefreshResult>();
  if (!port.configured()) {
    for (const ref of refs)
      results.set(entityRefKey(ref.entityKind, ref.entityId), {
        outcome: "unconfigured",
      });
    return results;
  }
  await enqueueEmbeddingRefs(db, await prepareSearchDocuments(db, refs));
  for (const ref of refs)
    results.set(entityRefKey(ref.entityKind, ref.entityId), {
      outcome: "pending",
    });
  return results;
}
