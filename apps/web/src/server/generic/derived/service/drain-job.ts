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
  DERIVED_DRAIN_JOB_KEY,
  derivedChunk,
  derivedWorkEligible,
  type DerivedChunk,
  type DerivedPagePlan,
  lockDerivedChunk,
  markAllStoredDerived,
  markExpiredClockDerived,
  prepareDerivedPage,
  publishDerivedChunk,
} from "~/server/generic/derived/repo/drain";
import { repeatJob } from "~/server/generic/jobs/repo/producer";
import { defineDrain } from "~/server/generic/jobs/service/drain";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { JobHandler } from "~/server/generic/jobs/types";
import { TraceNames, withTrace } from "~/server/observability/tracing";

const log = createLogger("derived");

export const DERIVED_RECONCILE_JOB_KEY = "derived:reconcile";
const DRAIN_REPEAT_MS = 60_000;
const RECONCILE_INTERVAL_MS = 60 * 60_000;
const RECONCILE_BUCKETS = 24;
// A sink retains its prepared results until publication. Finish one bounded
// batch before preparing more, so the invocation budget can yield between pages.
const DRAIN_PAGE_MARKS = 20;

/**
 * Each page claims ready marks, computes outside the transaction and
 * publishes through `defineDrain`; an idle page marks expired clock values.
 */
export const derivedDrainHandler = (
  computes: DerivedComputes,
  /** Production keeps the default page and chunk; test drains settle large fixtures in one transaction. */
  { limit = DRAIN_PAGE_MARKS, chunk }: { limit?: number; chunk?: number } = {},
): JobHandler =>
  defineDrain<{ plan: DerivedPagePlan; chunk: DerivedChunk }>({
    limit,
    eligible: derivedWorkEligible,
    chunk,
    repeats: true,
    async prepare(db, items) {
      const { plan, failed } = await withTrace(
        TraceNames.service("derived", "prepare"),
        () => prepareDerivedPage(db, computes, items),
        {
          "derived.marks": items.length,
          "derived.targets": [
            ...new Set(items.map((item) => item.target)),
          ].join(","),
        },
      );
      return { prepared: { plan, chunk: derivedChunk() }, failed };
    },
    lock: (tx, items, { plan, chunk }) =>
      lockDerivedChunk(tx, items, plan, chunk),
    async publish(tx, items, { plan, chunk }) {
      const publication = await withTrace(
        TraceNames.service("derived", "publish"),
        async (span) => {
          const result = await publishDerivedChunk(tx, items, plan, chunk);
          span.setAttributes({
            "derived.processed": items.length,
            "derived.changed": result.changed,
            "derived.expanded": result.expanded,
          });
          return result;
        },
      );
      if (publication.drift.length > 0)
        log.warn("derived.drift", { drift: publication.drift });
      if (publication.categories.length > 0)
        await recordChange(tx, {
          kind: "projection",
          categories: publication.categories,
          changes: publication.changes,
        });
      return { retain: publication.retain, covered: publication.covered };
    },
    async idle(tx) {
      await markExpiredClockDerived(tx);
    },
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
