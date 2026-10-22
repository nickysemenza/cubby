/**
 * One wake's drain: at most `pageLimit` Job pages or `timeBudgetMs` of wall
 * time, reselecting `batch` due Jobs per fair round. A drain that stops with
 * due work left publishes another wake.
 */
export const JOB_DRAIN = {
  pageLimit: 256,
  timeBudgetMs: 20_000,
  batch: 25,
} satisfies Record<string, number>;

/** A running page renews its lease this often. */
export const JOB_HEARTBEAT_MS = 30_000;
