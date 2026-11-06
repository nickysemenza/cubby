import {
  locationAiDescriptionRefreshTaskSchema,
  locationAiInventoryRefreshTaskSchema,
  imageMetadataExtractTaskSchema,
  maintenancePurchaseDiscoveryTaskSchema,
  calendarFeedMarkDirtyTaskSchema,
} from "@cubby/schemas/background-tasks";
import { jobWaitReason, type JOB_KIND_POLICY } from "@cubby/schemas/job";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { captureException } from "@sentry/tanstackstart-react";
import { z } from "zod";

import { aiEvaluationDrain } from "~/server/ai/evaluation/service/ai-evaluation-drain";
import { getPurchaseDispatchHostEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { DERIVED_REBUILD_LEASE_SECONDS } from "~/server/db/derived-rebuild-schema";
import { cloudImageDrain } from "~/server/domains/image-processing/service/cloud-drain";
import { deliverPurchaseDispatch } from "~/server/domains/purchase-agent/service/dispatch";
import { runAiEvaluationExecution } from "~/server/domains/run/service/ai-evaluation-execution";
import { aiRefreshDiscoveryDrain } from "~/server/domains/run/service/ai-refresh";
import { connectionDiscoveryDrain } from "~/server/domains/run/service/derived-discovery";
import {
  runDrains,
  type BackgroundDrain,
} from "~/server/generic/background/drains";
import {
  rebuildDerived,
  DerivedRebuildBusyError,
} from "~/server/generic/derived/service/rebuild";
import { embeddingCleanupDrain } from "~/server/generic/embedding/service/embedding-cleanup";
import { embeddingRefreshDrain } from "~/server/generic/embedding/service/embedding-refresh";
import { JOB_DRAIN } from "~/server/generic/jobs/limits";
import { readRebuildObservation as readDerivedRebuildStatus } from "~/server/generic/jobs/repo/observation";
import {
  defineJobHandler,
  drainDueJobs,
} from "~/server/generic/jobs/service/jobs";
import type { JobHandler, JobHandlers } from "~/server/generic/jobs/types";
import { handleBackgroundTask } from "~/server/workflows/background-tasks/handle";
import { withJobFence } from "~/server/workflows/runs/execution";
import { runJobHandler } from "~/server/workflows/runs/job-execution";

import { derivedComputes } from "./derived-computes";

/** Standalone provider Jobs check their lease before each paid request and fence their publications. */
const providerFenced = (handler: JobHandler): JobHandler => ({
  prepare: (db, job, context) =>
    withJobFence(context, () => handler.prepare(db, job, context)),
});

const background = defineJobHandler(
  z.discriminatedUnion("kind", [
    locationAiDescriptionRefreshTaskSchema,
    locationAiInventoryRefreshTaskSchema,
    imageMetadataExtractTaskSchema,
    maintenancePurchaseDiscoveryTaskSchema,
    calendarFeedMarkDirtyTaskSchema,
  ]),
  async (db, claim, task, context) => {
    if (task.kind !== claim.kind)
      throw new Error(`Job kind ${claim.kind} does not match ${task.kind}`);
    const outcome = await handleBackgroundTask(
      db,
      task,
      undefined,
      context.fenced,
    );
    return { page: { done: true, result: { outcome } } };
  },
);
const backgroundHandlers = {
  "location-ai.description.refresh": providerFenced(background),
  "location-ai.inventory.refresh": providerFenced(background),
  "image-metadata.extract": background,
  "maintenance.purchase-discovery": background,
  "calendar-feed.mark-dirty": background,
} satisfies Record<string, JobHandler>;

export const productionJobHandlers: JobHandlers = {
  ...backgroundHandlers,
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
    z.object({ runId: z.uuid().optional(), until: z.iso.datetime() }),
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
const derivedRebuildDrain: BackgroundDrain = {
  name: "derived-rebuild",
  page: async (db, { deadline }) => {
    try {
      const more = await rebuildDerived(db, derivedComputes, { deadline });
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
};
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
  limit = JOB_DRAIN.pageLimit,
) {
  const [jobs, drains] = await Promise.allSettled([
    drainDueJobs(db, productionJobHandlers, limit),
    runDrains(db, productionDrains()),
  ]);
  if (jobs.status === "rejected") throw jobs.reason;
  if (drains.status === "rejected") throw drains.reason;
  const pages = [jobs.value, drains.value];
  const { wakeAt, wakeJobs } =
    await import("~/server/workflows/background-tasks/publish");
  const next = pages
    .flatMap((page) => (page.nextAt ? [page.nextAt.getTime()] : []))
    .sort((a, b) => a - b)[0];
  if (pages.some((page) => page.more))
    await wakeJobs({ source: "background.more" });
  else if (next !== undefined)
    await wakeAt(new Date(next), { source: "background.next-due" });
  const outcomes = jobs.value.outcomes;
  await (
    await import("~/server/domains/purchase-import/repo/dispatch")
  ).reconcilePurchaseDispatches(db);
  await (
    await import("~/server/workflows/runs/lifecycle")
  ).reconcileWorkflowRuns(db);
  return outcomes;
}
