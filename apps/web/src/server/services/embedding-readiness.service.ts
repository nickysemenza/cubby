import type { EmbeddingReadiness } from "@cubby/schemas/relatedness";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import type { Database } from "~/server/db";
import { getEntityEmbeddingReadiness } from "~/server/repo/entity-embedding";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";

/**
 * One readiness seam for every explicit entity-to-entity semantic interaction.
 * An empty candidate list never has to impersonate missing, stale, or disabled
 * embeddings at callers again.
 */
export async function getEmbeddingReadiness(
  db: Database,
  ref: SearchableEntityRef,
): Promise<EmbeddingReadiness> {
  if (!semanticEmbeddingsConfigured()) return "unavailable";
  return await getEntityEmbeddingReadiness(
    db,
    ref,
    getSemanticEmbeddingConfig(),
  );
}

export const getEmbeddingReadinessFor = async (
  db: Database,
  entityType: SearchableEntity,
  entityId: string,
) => await getEmbeddingReadiness(db, { entityType, entityId });
