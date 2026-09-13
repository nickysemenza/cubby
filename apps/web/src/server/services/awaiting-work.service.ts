/**
 * Derived work that is waiting on a queue wakeup which may never arrive.
 *
 * Publication after a commit is best-effort: the mutation is already saved,
 * and the stale marker on the source row is the durable record of what still
 * needs doing. This service reads those markers directly — never a job ledger
 * — so the counts are live truth, and "Settle now" republishes exactly what
 * the counts describe. The nightly cron only asserts these are zero; it never
 * repairs, so a lost wakeup is visible instead of quietly absorbed.
 */

import type {
  AwaitingWork,
  SettleAwaitingWorkOut,
} from "@cubby/schemas/maintenance";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import { countCullablePendingImages } from "~/server/repo/image";
import {
  countStaleRecipeTotals,
  selectAllStaleRecipeIds,
} from "~/server/repo/recipe/totals";
import {
  countUnembeddedSearchDocuments,
  selectUnembeddedSearchDocumentRefs,
} from "~/server/repo/search-document";
import { getSemanticEmbeddingConfig } from "~/server/semantic/config";

import { cullPendingImageStorage } from "./image-storage.service";

/** Uploads abandoned after presign; the same threshold the presign cull uses. */
const PENDING_UPLOAD_HOURS = 24;

export async function countAwaitingWork(db: Database): Promise<AwaitingWork> {
  const [staleRecipeTotals, unembeddedEntities, pendingUploads] =
    await Promise.all([
      countStaleRecipeTotals(db),
      countUnembeddedSearchDocuments(db, getSemanticEmbeddingConfig()),
      countCullablePendingImages(db, PENDING_UPLOAD_HOURS),
    ]);
  return {
    staleRecipeTotals,
    unembeddedEntities,
    pendingUploads,
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

  return {
    publishedRecipeTasks: recipes.enqueued,
    publishedEmbeddingTasks,
    culledUploads: culled.count,
    transport,
  };
}
