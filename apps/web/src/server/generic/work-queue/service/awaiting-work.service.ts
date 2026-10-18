/** Source-row freshness markers recover lost queue publications automatically. */

import type {
  AwaitingWork,
  SettleAwaitingWorkOut,
} from "@cubby/schemas/maintenance";

import type { Database } from "~/server/db";
import {
  countCullablePendingImages,
  countImagesStaleMetadata,
  selectImagesForMetadataExtraction,
  cullPendingImageStorage,
} from "~/server/domains/image/repo/image";
import { buildImageMetadataExtractionTasks } from "~/server/domains/image/repo/image-metadata-tasks";
import {
  countStaleRecipeTotals,
  selectAllStaleRecipeIds,
} from "~/server/domains/recipe/repo/totals";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/generic/embedding/service/semantic/embeddings";
import {
  countUnembeddedSearchDocuments,
  selectUnembeddedSearchDocumentRefs,
} from "~/server/generic/search/repo/search-document";
import { publishBackgroundTasks } from "~/server/workflows/background-tasks/publish";

/** Each recovery invocation republishes a bounded page; later invocations advance it. */
const SETTLE_IMAGE_METADATA_BATCH_SIZE = 100;

/** Uploads abandoned after presign; the same threshold the presign cull uses. */
const PENDING_UPLOAD_HOURS = 24;

// Mirrors the gate in `problems.service.ts` (`countMissingEmbeddings`): with
// no AI_GATEWAY_API_KEY/Vectorize binding configured, every live row reads as
// unembedded and nothing can ever clear it, so report zero rather than an
// unfixable wall.
const countUnembeddedEntities = async (db: Database) =>
  semanticEmbeddingsConfigured()
    ? countUnembeddedSearchDocuments(db, getSemanticEmbeddingConfig())
    : 0;

export async function countAwaitingWork(db: Database): Promise<AwaitingWork> {
  const [
    staleRecipeTotals,
    unembeddedEntities,
    pendingUploads,
    staleImageMetadata,
  ] = await Promise.all([
    countStaleRecipeTotals(db),
    countUnembeddedEntities(db),
    countCullablePendingImages(db, PENDING_UPLOAD_HOURS),
    countImagesStaleMetadata(db),
  ]);
  return {
    staleRecipeTotals,
    unembeddedEntities,
    pendingUploads,
    staleImageMetadata,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Republish waiting items; embedding and image metadata work use bounded pages. Nothing here waits for completion — the queue
 * consumer does the work, and the counts above shrink as it
 * lands. Idempotent: republishing already-published work only costs each
 * handler its freshness check.
 */
export async function settleAwaitingWork(
  db: Database,
): Promise<SettleAwaitingWorkOut> {
  const { buildCrudServices } = await import("~/server/http/request-context");
  const { services } = buildCrudServices(db);
  const recipes = await services.recipeCosting.enqueueStaleQueued(
    await selectAllStaleRecipeIds(db),
  );

  const config = getSemanticEmbeddingConfig();
  const requestedAt = new Date().toISOString();
  let publishedEmbeddingTasks = 0;
  if (semanticEmbeddingsConfigured()) {
    const page = await selectUnembeddedSearchDocumentRefs(db, config);
    if (page.refs.length > 0) {
      const receipt = await publishBackgroundTasks(
        db,
        page.refs.map((ref) => ({
          kind: "entity-embedding.refresh" as const,
          requestedAt,
          entityKind: ref.entityKind,
          entityId: ref.entityId,
        })),
        { source: "maintenance.settle-awaiting-work" },
      );
      publishedEmbeddingTasks = receipt.count;
    }
  }

  const culled = await cullPendingImageStorage(db, PENDING_UPLOAD_HOURS);

  const staleImages = await selectImagesForMetadataExtraction(
    db,
    SETTLE_IMAGE_METADATA_BATCH_SIZE,
  );
  let publishedImageMetadataTasks = 0;
  if (staleImages.length > 0) {
    const receipt = await publishBackgroundTasks(
      db,
      buildImageMetadataExtractionTasks(staleImages.map((row) => row.id)),
      { source: "maintenance.settle-awaiting-work" },
    );
    publishedImageMetadataTasks = receipt.count;
  }

  return {
    publishedRecipeTasks: recipes.enqueued,
    publishedEmbeddingTasks,
    culledUploads: culled.count,
    publishedImageMetadataTasks,
    transport: "queue",
  };
}
