/**
 * The two derived Jobs (ADR 0021). `derived.drain` drains dirty marks page by
 * page; generated triggers capture it once per writing transaction, so it is
 * due whenever marks exist. `derived.reconcile` re-marks one of 24 id buckets
 * hourly at the lowest priority, so every stored value is rechecked daily
 * without a whole-corpus recompute each hour: an undeclared input shows up as
 * drift and converges instead of staying silently wrong.
 */
import { createLogger } from "@cubby/worker-tracing";
import { z } from "zod";

import type { Database } from "~/server/db";
import { recordChange } from "~/server/generic/changes/repo/change";
import type { DerivedComputes } from "~/server/generic/derived/repo/compute";
import {
  claimDerivedMarks,
  DERIVED_DRAIN_JOB_KEY,
  markAllStoredDerived,
  prepareDerivedPage,
  publishDerivedPage,
} from "~/server/generic/derived/repo/drain";
import { repeatJob } from "~/server/generic/jobs/repo/producer";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { JobHandler } from "~/server/generic/jobs/types";

const log = createLogger("derived");

export const DERIVED_RECONCILE_JOB_KEY = "derived:reconcile";
const DRAIN_REPEAT_MS = 60_000;
const RECONCILE_INTERVAL_MS = 60 * 60_000;
const RECONCILE_BUCKETS = 24;

/** Each page claims ready marks, computes outside the transaction and publishes. */
export const derivedDrainHandler = (computes: DerivedComputes): JobHandler =>
  defineJobHandler(z.object({}).passthrough(), async (db) => {
    const marks = await claimDerivedMarks(db);
    if (marks.length === 0) return { page: { done: true } };
    const plan = await prepareDerivedPage(db, computes, marks);
    return {
      page: { done: false },
      publish: async (tx) => {
        const publication = await publishDerivedPage(tx, plan);
        if (publication.drift.length > 0)
          log.warn("derived.drift", { drift: publication.drift });
        if (publication.categories.length > 0)
          await recordChange(tx, {
            kind: "projection",
            categories: publication.categories,
            changes: publication.changes,
          });
        return {
          processed: publication.processed,
          changed: publication.changed,
          expanded: publication.expanded,
        };
      },
    };
  });

export const derivedReconcileHandler: JobHandler = defineJobHandler(
  z.object({}).passthrough(),
  async () => ({
    page: { done: true },
    publish: async (tx) => ({
      marked: await markAllStoredDerived(tx, undefined, {
        index: new Date().getUTCHours() % RECONCILE_BUCKETS,
        count: RECONCILE_BUCKETS,
      }),
    }),
  }),
);

/** Catch-up keeps both Jobs present: the drain retries backed-off marks each minute. */
export async function scheduleDerivedJobs(db: Database): Promise<void> {
  await repeatJob(
    db,
    { key: DERIVED_DRAIN_JOB_KEY, kind: "derived.drain", input: {} },
    DRAIN_REPEAT_MS,
  );
  await repeatJob(
    db,
    { key: DERIVED_RECONCILE_JOB_KEY, kind: "derived.reconcile", input: {} },
    RECONCILE_INTERVAL_MS,
  );
}
