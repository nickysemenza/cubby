import { jobWaitReason, type JOB_KIND_POLICY } from "@cubby/schemas/job";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { sql } from "drizzle-orm";

import type { UnparsedError } from "~/lib/error-utils";
import { aiEvaluationDrain } from "~/server/ai/evaluation/service/ai-evaluation-drain";
import { getPurchaseDispatchHostEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { emailPurchaseDiscoveryDrain } from "~/server/domains/connection/service/email-purchase-discovery";
import { cloudImageDrain } from "~/server/domains/image-processing/service/cloud-drain";
import { deliverPurchaseDispatch } from "~/server/domains/purchase-agent/service/dispatch";
import type { PurchaseDispatchEnvironment } from "~/server/domains/purchase-agent/service/environment";
import {
  failedCoordinatorDispatchesSince,
  reconcileCoordinatorDispatches,
} from "~/server/domains/run/repo/coordinator-dispatch";
import { fundingResumeInput } from "~/server/domains/run/repo/execution-context";
import { runAiEvaluationExecution } from "~/server/domains/run/service/ai-evaluation-execution";
import { fieldAutomationDrain } from "~/server/domains/run/service/field-automation";
import { runSummaryDrain } from "~/server/domains/run/service/run-summary";
import type { BackgroundDrain } from "~/server/generic/background/drains";
import {
  derivedRebuildDue,
  derivedRebuildNext,
} from "~/server/generic/derived/repo/rebuild";
import {
  rebuildDerived,
  DerivedRebuildBusyError,
} from "~/server/generic/derived/service/rebuild";
import { embeddingCleanupDrain } from "~/server/generic/embedding/service/embedding-cleanup";
import { embeddingRefreshDrain } from "~/server/generic/embedding/service/embedding-refresh";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import { type PermitRuntime } from "~/server/generic/jobs/service/permits";
import type { JobHandler, JobHandlers } from "~/server/generic/jobs/types";
import { backgroundJobHandlers } from "~/server/workflows/background-tasks/kinds";
import { wakeAt, wakeJobs } from "~/server/workflows/background-tasks/publish";
import { runJobHandler } from "~/server/workflows/runs/job-execution";
import {
  reconcileWorkflowRuns,
  workflowRunsToReconcileSince,
} from "~/server/workflows/runs/lifecycle";

import { derivedComputes } from "./derived-computes";

/** Deliver one coordinator event through the environment `open` builds. */
export const purchaseDispatchHandler = (
  open: (
    waitUntil: (work: Promise<unknown>) => void,
  ) => Promise<PurchaseDispatchEnvironment>,
) =>
  defineJobHandler(purchaseAgentEvent, async (_db, _claim, event) => {
    const pending: Promise<unknown>[] = [];
    const outcome = await deliverPurchaseDispatch(
      event,
      await open((work) => {
        pending.push(work);
      }),
    );
    await Promise.all(pending);
    // A full coordinator cap is a capacity wait, not a failed attempt. The
    // coordinator keeps its place at the gate and brings this Job forward when
    // a turn is reserved for it; the fallback re-polls well inside the gate's
    // waiter lifetime.
    // An unreachable gate is the same wait, re-polled sooner: nothing will
    // wake this Job.
    if (typeof outcome === "object")
      throw outcome.waiting.unavailable
        ? new JobDeferredError(
            "Waiting for the coordinator gate to answer",
            new Date(Date.now() + 60_000 + Math.random() * 60_000),
            jobWaitReason.enum.provider_capacity,
          )
        : new JobDeferredError(
            `Waiting for a coordinator turn (${outcome.waiting.holders} running)`,
            new Date(Date.now() + 8 * 60_000 + Math.random() * 4 * 60_000),
            jobWaitReason.enum.provider_capacity,
          );
    return { page: { done: true, result: { outcome } } };
  });

export const productionJobHandlers: JobHandlers = {
  ...backgroundJobHandlers,
  "run.execute": runJobHandler,
  "purchase.dispatch": purchaseDispatchHandler(async (waitUntil) => {
    const env = getPurchaseDispatchHostEnv();
    if (!env)
      throw new Error("Purchase dispatch host environment is unavailable");
    const { purchaseDispatchEnvironment } =
      await import("~/server/domains/purchase-import/operations/agent-services");
    return purchaseDispatchEnvironment(env, { waitUntil });
  }),
  "run.funding-resume": defineJobHandler(
    // Rows enqueued before window keys still carry their Run; the handler resumes all.
    fundingResumeInput,
    async (db, _claim, { until }) => {
      // A budget raise brings every queued Job forward and resumes paused
      // work itself. This timer keeps its window end, so a re-exhaustion in
      // the same window still has a pending resume under this key.
      const deadline = new Date(until);
      if (deadline.getTime() > Date.now())
        return {
          page: {
            done: false,
            waitUntil: deadline,
            waitReason: jobWaitReason.enum.ai_funding_window,
          },
        };
      await (
        await import("~/server/ai/funding-wait")
      ).resumeFundingPausedRuns(db);
      return { page: { done: true } };
    },
  ),
} satisfies Record<
  // Drain record rows are never claimed as Jobs.
  Exclude<keyof typeof JOB_KIND_POLICY, "background.drain">,
  JobHandler
>;

/** Derived values keep one resumable hourly pass; a permit commits one page of it. */
const derivedRebuildDrain: BackgroundDrain = {
  name: "derived-rebuild",
  covers: (unit, key) =>
    unit === "derived-rebuild" && key.startsWith("derived-rebuild"),
  label: (unit) =>
    unit === "derived-rebuild" ? "Totals and search rebuild" : undefined,
  due: () => derivedRebuildDue("derived-rebuild"),
  next: derivedRebuildNext,
  async page(db) {
    try {
      await rebuildDerived(db, derivedComputes);
      return { claimed: 1 };
    } catch (error) {
      // Another permit holds the pass lease; its own successor continues it.
      if (error instanceof DerivedRebuildBusyError) return { claimed: 0 };
      throw error;
    }
  },
};

/**
 * Run and dispatch reconciliation as a unit: due only while a stopped
 * execution leaves its Run reading as running. The cron also runs it each tick.
 */
const reconcileDrain: BackgroundDrain = {
  name: "reconcile",
  label: (unit) => (unit === "reconcile" ? "Stopped Run cleanup" : undefined),
  due: () =>
    sql`SELECT 'reconcile'::text AS unit, false AS demand, owed.since
      FROM (SELECT least(${failedCoordinatorDispatchesSince()}, ${workflowRunsToReconcileSince()})::timestamp AS since) owed
      WHERE owed.since IS NOT NULL`,
  next: () => null,
  page: async (db) => ({ claimed: await reconcileStoppedWork(db) }),
};

export async function reconcileStoppedWork(db: Database) {
  let reconciled = await reconcileCoordinatorDispatches(db);
  let after: string | null = null;
  do {
    const page = await reconcileWorkflowRuns(db, after);
    reconciled += page.reconciled;
    after = page.next;
  } while (after);
  return reconciled;
}

// Built per permit: production ports participate in this module's import cycle.
const productionDrains = (): readonly BackgroundDrain[] => [
  cloudImageDrain,
  embeddingRefreshDrain(),
  embeddingCleanupDrain(),
  aiEvaluationDrain(runAiEvaluationExecution()),
  derivedRebuildDrain,
  emailPurchaseDiscoveryDrain,
  fieldAutomationDrain,
  runSummaryDrain,
  reconcileDrain,
];

/** Every production drain's `due` rows, for reads that report owed drain units. */
export const productionDrainDues = () =>
  productionDrains().map((drain) => ({
    name: drain.name,
    due:
      drain.due() ??
      sql`SELECT NULL::text AS unit, false AS demand, NULL::timestamp AS since WHERE false`,
    label: drain.label,
    stream: drain.stream,
    covers: drain.covers,
  }));

/** The production permit runtime: these handlers and drains, waking through the background queue. */
export function productionPermitRuntime(
  db: Database,
  captureException: (error: UnparsedError, unit?: string) => void,
): PermitRuntime {
  return {
    db,
    handlers: productionJobHandlers,
    drains: productionDrains(),
    ports: {
      send: (at, source, recover) =>
        at ? wakeAt(at, { source, recover }) : wakeJobs({ source }),
      captureException,
    },
  };
}
