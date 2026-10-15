export type BackfillStop = "complete" | "limit" | "no_progress";

/**
 * The bounded repair loop shared by the image backfills: select a page of
 * candidates, hand it to `process`, and stop on an empty page (`complete`), the
 * batch limit (`limit`), or a repeated page / a page where `process` reports no
 * progress (`no_progress`). A row that cannot be fixed must leave the
 * candidate set (or be marked) in `process`, or it would pin the first page.
 * `remaining === 0` after the loop always reports `complete`.
 */
export async function runBackfillBatches<Row extends { id: string }>(options: {
  maxBatches: number;
  batchSize: number;
  select: (batchSize: number) => Promise<readonly Row[]>;
  /** Handle one page; resolve `false` when nothing on it made progress. */
  process: (rows: readonly Row[]) => Promise<boolean>;
  count: () => Promise<number>;
}): Promise<{
  batches: number;
  scanned: number;
  remaining: number;
  stopped: BackfillStop;
}> {
  let batches = 0;
  let scanned = 0;
  let stopped: BackfillStop = "limit";
  const seenPages = new Set<string>();

  while (batches < options.maxBatches) {
    const rows = await options.select(options.batchSize);
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
    if (!(await options.process(rows))) {
      stopped = "no_progress";
      break;
    }
  }

  const remaining = await options.count();
  if (remaining === 0) stopped = "complete";
  return { batches, scanned, remaining, stopped };
}
