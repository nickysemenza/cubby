import type {
  RepairImageDimensionsInput,
  RepairImageDimensionsOut,
} from "@cubby/schemas/maintenance";

import type { Database } from "~/server/db";
import {
  countImagesMissingDimensions,
  selectImagesMissingDimensions,
} from "~/server/repo/image";
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
  let batches = 0;
  let scanned = 0;
  let repaired = 0;
  let failed = 0;
  let stopped: RepairImageDimensionsOut["stopped"] = "limit";
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
    const results = await ports.verify(db, rows);
    batches += 1;
    scanned += rows.length;
    repaired += results.filter(
      ({ storageStatus }) => storageStatus === "available",
    ).length;
    failed += results.filter(
      ({ storageStatus }) => storageStatus !== "available",
    ).length;
    if (results.length === 0) {
      stopped = "no_progress";
      break;
    }
  }

  const remaining = await ports.count(db);
  if (remaining === 0) stopped = "complete";
  return { batches, scanned, repaired, failed, remaining, stopped };
}
