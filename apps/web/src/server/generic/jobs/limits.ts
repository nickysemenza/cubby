/**
 * One wake's drain: at most `pageLimit` Job pages or `timeBudgetMs` of wall
 * time, reselecting `batch` due Jobs per fair round and running up to
 * `concurrency` of a round's pages at once. A drain that stops with due work
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

/** A running page renews its lease this often. */
export const JOB_HEARTBEAT_MS = 30_000;
