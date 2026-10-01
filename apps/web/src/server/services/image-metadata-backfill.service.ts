import type {
  BackfillImageMetadataInput,
  BackfillImageMetadataOut,
} from "@cubby/schemas/maintenance";

import type { Database } from "~/server/db";
import {
  countImagesStaleMetadata,
  selectImagesForMetadataExtraction,
} from "~/server/repo/image";
import { runBackfillBatches } from "~/server/services/backfill-batches";
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
  let extracted = 0;
  let skipped = 0;
  const result = await runBackfillBatches({
    maxBatches: input.maxBatches,
    batchSize: input.batchSize,
    select: (batchSize) => ports.select(db, batchSize),
    count: () => ports.count(db),
    process: async (rows) => {
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
      return progressed;
    },
  });
  return { ...result, extracted, skipped };
}
