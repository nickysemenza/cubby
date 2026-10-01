import type {
  RepairImageDimensionsInput,
  RepairImageDimensionsOut,
} from "@cubby/schemas/maintenance";

import type { Database } from "~/server/db";
import {
  countImagesMissingDimensions,
  selectImagesMissingDimensions,
} from "~/server/repo/image";
import { runBackfillBatches } from "~/server/services/backfill-batches";
import { verifyImageRows } from "~/server/services/image-verification.service";

type RepairPorts = {
  select: typeof selectImagesMissingDimensions;
  verify: typeof verifyImageRows;
  count: typeof countImagesMissingDimensions;
};

const productionPorts: RepairPorts = {
  select: selectImagesMissingDimensions,
  verify: verifyImageRows,
  count: countImagesMissingDimensions,
};

/**
 * Backfill dimensions through the same full-byte integrity path used by an
 * explicit verification. Each pass is bounded and rows that cannot be read or
 * decoded are marked unavailable, so they cannot pin the first page forever.
 */
export async function repairImageDimensions(
  db: Database,
  input: RepairImageDimensionsInput,
  ports: RepairPorts = productionPorts,
): Promise<RepairImageDimensionsOut> {
  let repaired = 0;
  let failed = 0;
  const result = await runBackfillBatches({
    maxBatches: input.maxBatches,
    batchSize: input.batchSize,
    select: (batchSize) => ports.select(db, batchSize),
    count: () => ports.count(db),
    process: async (rows) => {
      const results = await ports.verify(db, [...rows]);
      for (const { storageStatus } of results) {
        if (storageStatus === "available") repaired += 1;
        else failed += 1;
      }
      return results.length > 0;
    },
  });
  return { ...result, repaired, failed };
}
