import {
  locationAiDescriptionRefreshTaskSchema,
  locationAiInventoryRefreshTaskSchema,
  imageMetadataExtractTaskSchema,
  maintenancePurchaseDiscoveryTaskSchema,
  calendarFeedMarkDirtyTaskSchema,
} from "@cubby/schemas/background-tasks";
import { jobWaitReason, type JOB_KIND_POLICY } from "@cubby/schemas/job";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { z } from "zod";

import { getPurchaseDispatchHostEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { deviceWakeHandler } from "~/server/domains/image-processing/service/device-wake";
import { imageProcessingJobHandler } from "~/server/domains/image-processing/service/dispatch";
import { deliverPurchaseDispatch } from "~/server/domains/purchase-agent/service/dispatch";
import { aiEvaluationJobHandler } from "~/server/domains/run/service/ai-evaluation-drain";
import { connectionDiscoveryJobHandler } from "~/server/domains/run/service/derived-discovery";
import { correctionPropagationHandler } from "~/server/generic/assessment/service/correction-propagation";
import {
  derivedDrainHandler,
  derivedReconcileHandler,
} from "~/server/generic/derived/service/drain-job";
import { embeddingCleanupHandler } from "~/server/generic/embedding/service/embedding-cleanup";
import { embeddingRefreshHandler } from "~/server/generic/embedding/service/embedding-refresh";
import { JOB_DRAIN } from "~/server/generic/jobs/limits";
import {
  defineJobHandler,
  drainDueJobs,
} from "~/server/generic/jobs/service/jobs";
import type { JobHandler, JobHandlers } from "~/server/generic/jobs/types";
import { handleBackgroundTask } from "~/server/workflows/background-tasks/handle";
import { runJobHandler } from "~/server/workflows/runs/job-execution";

import { aiRefreshActivationHandler } from "./ai-refresh-startup";
import { derivedComputes } from "./derived-computes";
import { jobMaintenanceHandler } from "./job-maintenance";

const background = defineJobHandler(
  z.discriminatedUnion("kind", [
    locationAiDescriptionRefreshTaskSchema,
    locationAiInventoryRefreshTaskSchema,
    imageMetadataExtractTaskSchema,
    maintenancePurchaseDiscoveryTaskSchema,
    calendarFeedMarkDirtyTaskSchema,
  ]),
  async (db, claim, task) => {
    if (task.kind !== claim.kind)
      throw new Error(`Job kind ${claim.kind} does not match ${task.kind}`);
    const outcome = await handleBackgroundTask(db, task);
    return { page: { done: true, result: { outcome } } };
  },
);
const backgroundHandlers = {
  "location-ai.description.refresh": background,
  "location-ai.inventory.refresh": background,
  "image-metadata.extract": background,
  "maintenance.purchase-discovery": background,
  "calendar-feed.mark-dirty": background,
} satisfies Record<string, JobHandler>;

export const productionJobHandlers: JobHandlers = {
  ...backgroundHandlers,
  "assessment.correction": correctionPropagationHandler,
  "derived.drain": derivedDrainHandler(derivedComputes),
  "derived.reconcile": derivedReconcileHandler,
  "discovery.connections": connectionDiscoveryJobHandler,
  "embedding.refresh": embeddingRefreshHandler(),
  "embedding.cleanup": embeddingCleanupHandler(),
  // `image.device` has no server handler: Apple devices claim it by pull.
  "image.cloud": imageProcessingJobHandler,
  "run.execute": runJobHandler,
  "ai.evaluation": aiEvaluationJobHandler(),
  "ai-refresh.activate": aiRefreshActivationHandler,
  "image.device.wake": deviceWakeHandler,
  "jobs.maintenance": jobMaintenanceHandler,
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
} satisfies Record<
  Exclude<keyof typeof JOB_KIND_POLICY, "image.device">,
  JobHandler
>;
export async function drainProductionJobs(
  db: Database,
  limit = JOB_DRAIN.pageLimit,
) {
  const outcomes = await drainDueJobs(db, productionJobHandlers, limit);
  await (
    await import("~/server/domains/purchase-import/repo/dispatch")
  ).reconcilePurchaseDispatches(db);
  return outcomes;
}
