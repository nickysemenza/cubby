/**
 * One wake's drain: at most `pageLimit` Job pages or `timeBudgetMs` of wall
 * time, reselecting `batch` due seed Jobs per fair round and running up to
 * `concurrency` pages at once. Free lanes reselect while siblings run.
 * A drain that stops with admitted due work
 * left publishes another wake.
 */
export const JOB_DRAIN = {
  pageLimit: 256,
  timeBudgetMs: 20_000,
  batch: 25,
  // Each Worker request holds five strong database sockets; three pages
  // leave room for a page that briefly holds two (a transaction plus a read).
  concurrency: 3,
} satisfies Record<string, number>;

/** A batch page's serial claims stop at this share of its remaining drain budget. */
export const JOB_BATCH_CLAIM_SHARE = 0.4;

/** A running page renews its lease this often. */
export const JOB_HEARTBEAT_MS = 30_000;
