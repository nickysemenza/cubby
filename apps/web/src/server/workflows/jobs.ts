import { jobWaitReason, type JOB_KIND_POLICY } from "@cubby/schemas/job";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { captureException } from "@sentry/tanstackstart-react";

import { aiEvaluationDrain } from "~/server/ai/evaluation/service/ai-evaluation-drain";
import { getPurchaseDispatchHostEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { DERIVED_REBUILD_LEASE_SECONDS } from "~/server/db/derived-rebuild-schema";
import { cloudImageDrain } from "~/server/domains/image-processing/service/cloud-drain";
import { deliverPurchaseDispatch } from "~/server/domains/purchase-agent/service/dispatch";
import { fundingResumeInput } from "~/server/domains/run/repo/execution-context";
import { runAiEvaluationExecution } from "~/server/domains/run/service/ai-evaluation-execution";
import { aiRefreshDiscoveryDrain } from "~/server/domains/run/service/ai-refresh";
import { connectionDiscoveryDrain } from "~/server/domains/run/service/derived-discovery";
import {
  admittedDrain,
  type BackgroundDrain,
} from "~/server/generic/background/drains";
import { runBackgroundRound } from "~/server/generic/background/work-round";
import {
  rebuildDerived,
  DerivedRebuildBusyError,
} from "~/server/generic/derived/service/rebuild";
import { embeddingCleanupDrain } from "~/server/generic/embedding/service/embedding-cleanup";
import { embeddingRefreshDrain } from "~/server/generic/embedding/service/embedding-refresh";
import { readRebuildObservation as readDerivedRebuildStatus } from "~/server/generic/jobs/repo/observation";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { JobHandler, JobHandlers } from "~/server/generic/jobs/types";
import { backgroundJobHandlers } from "~/server/workflows/background-tasks/kinds";
import { runJobHandler } from "~/server/workflows/runs/job-execution";

import { derivedComputes } from "./derived-computes";

export const productionJobHandlers: JobHandlers = {
  ...backgroundJobHandlers,
  "run.execute": runJobHandler,
  "purchase.dispatch": defineJobHandler(
    purchaseAgentEvent,
    async (_db, _claim, event) => {
      const env = getPurchaseDispatchHostEnv();
      if (!env)
        throw new Error("Purchase dispatch host environment is unavailable");
      const { purchaseDispatchEnvironment } =
        await import("~/server/domains/purchase-import/operations/agent-services");
      const pending: Promise<unknown>[] = [];
      const outcome = await deliverPurchaseDispatch(
        event,
        purchaseDispatchEnvironment(env, {
          waitUntil: (work) => {
            pending.push(work);
          },
        }),
      );
      await Promise.all(pending);
      return { page: { done: true, result: { outcome } } };
    },
  ),
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
        await import("~/server/domains/run/service/ai-work")
      ).resumeFundingPausedRuns(db);
      return { page: { done: true } };
    },
  ),
} satisfies Record<keyof typeof JOB_KIND_POLICY, JobHandler>;

/** Work owned by its domain's rows: no Job row, one registration here. */
const derivedRebuildDrain: BackgroundDrain = admittedDrain({
  name: "derived-rebuild",
  page: async (db, { deadline }) => {
    try {
      const more = await rebuildDerived(db, derivedComputes, {
        deadline,
        pageLimit: 1,
      });
      const status = more ? null : await readDerivedRebuildStatus(db);
      return {
        more,
        nextAt:
          status?.running && status.failures
            ? new Date(Date.now() + 5 * 60_000)
            : null,
      };
    } catch (error) {
      if (error instanceof DerivedRebuildBusyError)
        return {
          more: false,
          nextAt: new Date(Date.now() + DERIVED_REBUILD_LEASE_SECONDS * 1000),
        };
      captureException(error);
      return { more: false, nextAt: new Date(Date.now() + 5 * 60_000) };
    }
  },
});
// Built per round: production ports participate in this module's import cycle.
const productionDrains = (): readonly BackgroundDrain[] => [
  cloudImageDrain,
  embeddingRefreshDrain(),
  embeddingCleanupDrain(),
  aiEvaluationDrain(runAiEvaluationExecution()),
  derivedRebuildDrain,
  aiRefreshDiscoveryDrain,
  connectionDiscoveryDrain,
];

export async function drainProductionJobs(
  db: Database,
  options: { limit?: number; afterDrain?: string } = {},
) {
  const round = await runBackgroundRound(
    db,
    productionJobHandlers,
    productionDrains(),
    options,
  );
  const { wakeAt, wakeJobs } =
    await import("~/server/workflows/background-tasks/publish");
  if (round.more)
    await wakeJobs({ source: "background.more", afterDrain: round.afterDrain });
  else if (round.nextAt)
    await wakeAt(round.nextAt, {
      source: "background.next-due",
      afterDrain: round.afterDrain,
    });
  // Preserve the continuation before transport retries an older failed envelope.
  if (round.failures.length === 1) throw round.failures[0];
  if (round.failures.length)
    throw new AggregateError(round.failures, "Background pages failed");
  await (
    await import("~/server/domains/run/repo/coordinator-dispatch")
  ).reconcileCoordinatorDispatches(db);
  await (
    await import("~/server/workflows/runs/lifecycle")
  ).reconcileWorkflowRuns(db);
  return round.outcomes;
}
