import type {
  BackfillImageMetadataInput,
  BackfillImageMetadataOut,
} from "@cubby/schemas/maintenance";

import type { Database } from "~/server/db";
import {
  countImagesStaleMetadata,
  selectImagesForMetadataExtraction,
} from "~/server/repo/image";
import { extractAndStoreImageMetadata } from "~/server/services/image-metadata-extraction.service";

type BackfillPorts = {
  select: typeof selectImagesForMetadataExtraction;
  extract: typeof extractAndStoreImageMetadata;
  count: typeof countImagesStaleMetadata;
};

const productionPorts: BackfillPorts = {
  select: selectImagesForMetadataExtraction,
  extract: extractAndStoreImageMetadata,
  count: countImagesStaleMetadata,
};

/**
 * Bounded repair for images whose `metadataRevision` stale marker a lost
 * queue wakeup left behind — same bounded-loop shape as
 * `repairImageDimensions`: each pass selects a page of candidates, runs
 * extraction on every row, and stops on an empty page (`complete`), the
 * batch limit (`limit`), or a repeated/empty-progress page (`no_progress`).
 */
export async function backfillImageMetadata(
  db: Database,
  input: BackfillImageMetadataInput,
  ports: BackfillPorts = productionPorts,
): Promise<BackfillImageMetadataOut> {
  let batches = 0;
  let scanned = 0;
  let extracted = 0;
  let skipped = 0;
  let stopped: BackfillImageMetadataOut["stopped"] = "limit";
  const seenPages = new Set<string>();

  while (batches < input.maxBatches) {
    const rows = await ports.select(db, input.batchSize);
    if (rows.length === 0) {
      stopped = "complete";
      break;
    }
    const pageKey = rows
      .map(({ id }) => id)
      .sort()
      .join(",");
    if (seenPages.has(pageKey)) {
      stopped = "no_progress";
      break;
    }
    seenPages.add(pageKey);
    batches += 1;
    scanned += rows.length;

    let progressed = false;
    for (const row of rows) {
      const outcome = await ports.extract(db, row.id);
      if (outcome === "succeeded") {
        extracted += 1;
        progressed = true;
      } else {
        skipped += 1;
      }
    }
    if (!progressed) {
      stopped = "no_progress";
      break;
    }
  }

  const remaining = await ports.count(db);
  if (remaining === 0) stopped = "complete";
  return { batches, scanned, extracted, skipped, remaining, stopped };
}
