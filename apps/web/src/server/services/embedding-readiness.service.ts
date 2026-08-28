import type { EmbeddingReadiness } from "@cubby/schemas/relatedness";
import type { SearchableEntityRef } from "@cubby/schemas/search";

import type { Database } from "~/server/db";
import { getEntityEmbeddingReadiness } from "~/server/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";

export interface EmbeddingReadinessPort {
  readonly configured: () => boolean;
  readonly config: typeof getSemanticEmbeddingConfig;
  readonly read: typeof getEntityEmbeddingReadiness;
}

const productionEmbeddingReadinessPort: EmbeddingReadinessPort = {
  configured: semanticEmbeddingsConfigured,
  config: getSemanticEmbeddingConfig,
  read: getEntityEmbeddingReadiness,
};

/**
 * One readiness seam for every explicit entity-to-entity semantic interaction.
 * An empty candidate list never has to impersonate missing, stale, or disabled
 * embeddings at callers again.
 */
export async function getEmbeddingReadiness(
  db: Database | undefined,
  ref: SearchableEntityRef,
  port: EmbeddingReadinessPort = productionEmbeddingReadinessPort,
): Promise<EmbeddingReadiness> {
  if (!port.configured()) return "unavailable";
  if (!db) throw new Error("Configured embeddings require a database.");
  return await port.read(db, ref, port.config());
}
