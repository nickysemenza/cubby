import {
  locationAiDescriptionRefreshTaskSchema,
  locationAiInventoryRefreshTaskSchema,
  imageProcessingResultTaskSchema,
  imageMetadataExtractTaskSchema,
  maintenancePurchaseDiscoveryTaskSchema,
  calendarFeedMarkDirtyTaskSchema,
} from "@cubby/schemas/background-tasks";
import { purchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { z } from "zod";

import { getPurchaseDispatchHostEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { imageProcessingJobHandler } from "~/server/domains/image-processing/service/dispatch";
import { deliverPurchaseDispatch } from "~/server/domains/purchase-agent/service/dispatch";
import { connectionDiscoveryJobHandler } from "~/server/domains/run/service/derived-discovery";
import { embeddingCleanupHandler } from "~/server/generic/embedding/service/embedding-cleanup";
import {
  defineJobHandler,
  drainDueJobs,
} from "~/server/generic/jobs/service/jobs";
import type { JobHandler, JobHandlers } from "~/server/generic/jobs/types";
import { embeddingJobHandler } from "~/server/workflows/background-tasks/embedding";
import { handleBackgroundTask } from "~/server/workflows/background-tasks/handle";
import { refreshFamilyHandler } from "~/server/workflows/background-tasks/refresh-families";
import {
  runJobHandler,
  aiEvaluationJobHandler,
} from "~/server/workflows/runs/job-execution";

import { aiRefreshActivationHandler } from "./ai-refresh-startup";

const background = defineJobHandler(
  z.discriminatedUnion("kind", [
    locationAiDescriptionRefreshTaskSchema,
    locationAiInventoryRefreshTaskSchema,
    imageProcessingResultTaskSchema,
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
  "image-processing.result": background,
  "image-metadata.extract": background,
  "maintenance.purchase-discovery": background,
  "calendar-feed.mark-dirty": background,
} satisfies Record<string, JobHandler>;

export const productionJobHandlers: JobHandlers = {
  ...backgroundHandlers,
  "refresh.family": refreshFamilyHandler,
  "discovery.connections": connectionDiscoveryJobHandler,
  "embedding.refresh": embeddingJobHandler(),
  "embedding.cleanup": embeddingCleanupHandler(),
  "image.processing": imageProcessingJobHandler,
  "run.execute": runJobHandler,
  "ai.evaluation": aiEvaluationJobHandler,
  "ai-refresh.activate": aiRefreshActivationHandler,
  "purchase.dispatch": defineJobHandler(
    purchaseAgentEvent,
    async (_db, _claim, event) => {
      const env = getPurchaseDispatchHostEnv();
      if (!env)
        throw new Error("Purchase dispatch host environment is unavailable");
      const { purchaseDispatchEnvironment } =
        await import("~/server/domains/purchase-import/operations/agent-host");
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
    z.object({ runId: z.uuid(), until: z.iso.datetime() }),
    async (db) => {
      await (
        await import("~/server/domains/run/service/ai-work")
      ).resumeFundingPausedRuns(db);
      return { page: { done: true } };
    },
  ),
};
export async function drainProductionJobs(db: Database, limit = 256) {
  const outcomes = await drainDueJobs(db, productionJobHandlers, limit);
  await (
    await import("~/server/domains/purchase-import/repo/dispatch")
  ).reconcilePurchaseDispatches(db);
  return outcomes;
}
