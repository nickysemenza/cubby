/**
 * Derived work that is waiting on a queue wakeup which may never arrive.
 *
 * Publication after a commit is best-effort: the mutation is already saved,
 * and the stale marker on the source row is the durable record of what still
 * needs doing. This service reads those markers directly — never a job ledger
 * — so the counts are live truth, and "Settle now" republishes exactly what
 * the counts describe. The nightly cron asserts these are zero and repairs
 * the embedding backlog it finds (see the cron's repair block); other backlogs
 * still surface here rather than being silently absorbed.
 */

import type {
  AwaitingWork,
  SettleAwaitingWorkOut,
} from "@cubby/schemas/maintenance";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import {
  countCullablePendingImages,
  countImagesStaleMetadata,
  selectImagesForMetadataExtraction,
} from "~/server/repo/image";
import {
  countStaleRecipeTotals,
  selectAllStaleRecipeIds,
} from "~/server/repo/recipe/totals";
import {
  countUnembeddedSearchDocuments,
  selectUnembeddedSearchDocumentRefs,
} from "~/server/repo/search-document";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";
import { semanticEmbeddingsConfigured } from "~/server/semantic/embeddings";
import { buildImageMetadataExtractionTasks } from "~/server/services/image-metadata-extraction.service";

import { cullPendingImageStorage } from "./image-storage.service";

/** One page is plenty for a repair republish — "Settle now" only needs to
 * repair a LOST wakeup, not drive the whole backlog; `backfillImageMetadata`
 * maintenance is the bounded loop for a larger one. */
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
 * Republish every waiting item. Nothing here waits for completion — the queue
 * (or the inline dev path) does the work, and the counts above shrink as it
 * lands. Idempotent: republishing already-published work only costs each
 * handler its freshness check.
 */
export async function settleAwaitingWork(
  db: Database,
): Promise<SettleAwaitingWorkOut> {
  const { buildCrudServices } = await import("~/server/request-context");
  const { services } = buildCrudServices(db);
  const recipes = await services.recipeCosting.enqueueStaleQueued(
    await selectAllStaleRecipeIds(db),
  );

  const config = getSemanticEmbeddingConfig();
  const requestedAt = new Date().toISOString();
  let publishedEmbeddingTasks = 0;
  let transport: SettleAwaitingWorkOut["transport"] = "queue";
  let page = await selectUnembeddedSearchDocumentRefs(db, config);
  for (;;) {
    if (page.refs.length > 0) {
      const receipt = await publishBackgroundTasks(
        db,
        page.refs.map((ref) => ({
          kind: "entity-embedding.refresh" as const,
          requestedAt,
          entityType: ref.entityType,
          entityId: ref.entityId,
        })),
        { source: "maintenance.settle-awaiting-work" },
      );
      publishedEmbeddingTasks += receipt.count;
      transport = receipt.transport;
    }
    if (!page.nextCursor) break;
    page = await selectUnembeddedSearchDocumentRefs(db, config, {
      cursor: page.nextCursor,
    });
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
    transport = receipt.transport;
  }

  return {
    publishedRecipeTasks: recipes.enqueued,
    publishedEmbeddingTasks,
    culledUploads: culled.count,
    publishedImageMetadataTasks,
    transport,
  };
}
