import type {
  BackfillImageSearchInput,
  BackfillImageSearchOut,
} from "@cubby/schemas/maintenance";

import type { Database } from "~/server/db";
import {
  countImagesMissingSearchDocument,
  selectImageIdsMissingSearchDocument,
} from "~/server/repo/image";
import { refreshDerivedSearchRefs } from "~/server/services/mutation-side-effects";

/**
 * Project and queue embeddings for live images that never got a SearchDocument.
 * Keyset-paged on the image id so a page whose projection fails to land cannot
 * be selected again within the same run.
 */
export async function backfillImageSearchDocuments(
  db: Database,
  input: BackfillImageSearchInput,
): Promise<BackfillImageSearchOut> {
  let batches = 0;
  let scanned = 0;
  let afterId: string | undefined;
  let stopped: BackfillImageSearchOut["stopped"] = "limit";

  while (batches < input.maxBatches) {
    const ids = await selectImageIdsMissingSearchDocument(db, {
      afterId,
      limit: input.batchSize,
    });
    if (ids.length === 0) {
      stopped = "complete";
      break;
    }
    batches += 1;
    scanned += ids.length;
    afterId = ids.at(-1);
    await refreshDerivedSearchRefs(
      db,
      ids.map((entityId) => ({ entityKind: "image" as const, entityId })),
      "maintenance.backfill-image-search",
    );
  }

  const remaining = await countImagesMissingSearchDocument(db);
  if (remaining === 0) stopped = "complete";
  return { batches, scanned, published: scanned, remaining, stopped };
}
