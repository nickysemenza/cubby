/**
 * The two derived Jobs (ADR 0021). `derived.drain` drains dirty marks page by
 * page; generated triggers capture it once per writing transaction, so it is
 * due whenever marks exist. `derived.reconcile` re-marks one of 24 id buckets
 * hourly at the lowest priority, so every stored value is rechecked daily
 * without a whole-corpus recompute each hour: an undeclared input shows up as
 * drift and converges instead of staying silently wrong.
 */
import { createLogger } from "@cubby/worker-tracing";
import { and, notLike } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { recordChange } from "~/server/generic/changes/repo/change";
import type { DerivedComputes } from "~/server/generic/derived/repo/compute";
import {
  DERIVED_DRAIN_JOB_KEY,
  DERIVED_COMPUTE_BATCH,
  admitDerivedPage,
  derivedChunk,
  derivedPreparationCost,
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
import {
  defineDrain,
  type DrainSpec,
} from "~/server/generic/jobs/service/drain";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { JobHandler, PreparedJobPage } from "~/server/generic/jobs/types";
import { TraceNames, withTrace } from "~/server/observability/tracing";

const log = createLogger("derived");

export const DERIVED_RECONCILE_JOB_KEY = "derived:reconcile";
const DRAIN_REPEAT_MS = 60_000;
const RECONCILE_INTERVAL_MS = 60 * 60_000;
const RECONCILE_BUCKETS = 24;
// Source expansion has no canonical preparation; retain its previous maximum
// independently of the direct-only preparation allowance.
const DERIVED_FANOUT_BATCH = 20;

/**
 * Each page claims ready marks, computes outside the transaction and
 * publishes through `defineDrain`; an idle page marks expired clock values.
 */
type DerivedPreparation = { plan: DerivedPagePlan; chunk: DerivedChunk };

const derivedDrain = (
  computes: DerivedComputes,
  {
    limit,
    chunk,
    admit,
    eligible,
  }: {
    limit?: number;
    chunk?: number;
    admit?: DrainSpec<DerivedPreparation>["admit"];
    eligible?: DrainSpec<DerivedPreparation>["eligible"];
  },
): JobHandler =>
  defineDrain<DerivedPreparation>({
    limit: limit ?? DERIVED_COMPUTE_BATCH,
    admit:
      admit ??
      (limit === undefined
        ? (items) => admitDerivedPage({ items, computes })
        : undefined),
    eligible: eligible ?? derivedWorkEligible,
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

const drainCount = (page: PreparedJobPage, key: string): number => {
  const result = page.page.result;
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return 0;
  const value = result[key];
  return typeof value === "number" ? value : 0;
};

/** Expand a bounded source prefix before freshly bounded canonical preparation. */
export const derivedDrainHandler = (
  computes: DerivedComputes,
  /** Explicit limits retain the fixture drain's single-phase behavior. */
  { limit, chunk }: { limit?: number; chunk?: number } = {},
): JobHandler => {
  if (limit !== undefined) return derivedDrain(computes, { limit, chunk });
  return {
    async prepare(db, claim, context) {
      // A superseded invocation can still unwind while its replacement runs.
      // Never share admission state between invocations of this handler.
      let expandedFirst = false;
      let directReservation = 0;
      let overflowPriority: number | undefined;
      const first = await derivedDrain(computes, {
        chunk,
        admit(items) {
          let fanoutCount = 0;
          let directCost = 0;
          let count = 0;
          for (const item of items) {
            if (item.target.includes("@")) {
              if (fanoutCount === DERIVED_FANOUT_BATCH) break;
              fanoutCount++;
            } else {
              const next = directCost + derivedPreparationCost(item, computes);
              if (next > DERIVED_COMPUTE_BATCH) break;
              directCost = next;
            }
            count++;
          }
          const prefix = items.slice(0, count);
          const fanouts = prefix.filter((item) => item.target.includes("@"));
          // Ordinary direct-only pages keep their existing single read/pass.
          if (!fanouts.length) return prefix;
          expandedFirst = true;
          overflowPriority = items[prefix.length]?.priority;
          directReservation = directCost;
          return fanouts;
        },
      }).prepare(db, claim, context);
      if (!expandedFirst) return first;
      await context.check();
      const direct = await derivedDrain(computes, {
        chunk,
        // Busy fanouts spent their expansion slot already and remain owed.
        // The direct phase never retries them ahead of independent values.
        eligible: (target) =>
          and(derivedWorkEligible(target), notLike(target, "%@%"))!,
        admit(items) {
          if (overflowPriority === undefined)
            return admitDerivedPage({ items, computes });
          let used = 0;
          let count = 0;
          for (const item of items) {
            // Fresh member work can precede an unaffordable background item.
            // At its priority or lower, cumulative cost keeps the reservation.
            const allowance =
              item.priority < overflowPriority
                ? DERIVED_COMPUTE_BATCH
                : directReservation;
            const next = used + derivedPreparationCost(item, computes);
            if (next > allowance) break;
            used = next;
            count++;
          }
          return items.slice(0, count);
        },
      }).prepare(db, claim, context);
      return {
        ...direct,
        page: {
          ...direct.page,
          done: false,
          result: Object.fromEntries(
            ["processed", "published", "failed", "covered"].map((key) => [
              key,
              drainCount(first, key) + drainCount(direct, key),
            ]),
          ),
        },
      };
    },
  };
};

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
