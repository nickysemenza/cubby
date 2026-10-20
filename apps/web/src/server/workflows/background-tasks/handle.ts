import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { entityRefKey } from "@cubby/schemas/entity";
import { runEntityId, type ImageId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db";
import type { WorkflowRunParams } from "~/server/workflows/runs/contract";

import {
  type EmbeddingRefreshPort,
  productionEmbeddingRefreshPort,
  refreshEntityEmbeddings,
} from "./embedding";

const log = createLogger("background-tasks");

export type BackgroundTaskOutcome = "succeeded" | "skipped";

type ExtractImageMetadataPort = (
  db: Database,
  imageId: ImageId,
) => Promise<BackgroundTaskOutcome>;

/** Lazily imports the real service — keeps it out of the request-time bundle
 * (same reason every other branch below dynamic-imports its handler
 * module), while still going through the `BackgroundTaskPorts` seam a test
 * can inject a faithful fake into instead of mocking the module. */
const productionExtractImageMetadata: ExtractImageMetadataPort = async (
  db,
  imageId,
) => {
  const { extractAndStoreImageMetadata } =
    await import("~/server/domains/image/service/image-metadata-extraction.service");
  const outcome = await extractAndStoreImageMetadata(db, imageId);
  return outcome === "succeeded" ? "succeeded" : "skipped";
};

type MarkCalendarFeedDirtyPort = (
  origin: string,
  reason: string,
) => Promise<void>;

const productionMarkCalendarFeedDirty: MarkCalendarFeedDirtyPort = async (
  origin,
  reason,
) => {
  const { calendarFeedStateFor } =
    await import("~/server/domains/calendar/repo/client");
  await (await calendarFeedStateFor(origin)).markDirty(reason);
};

export interface BackgroundTaskPorts {
  readonly continueWorkflow: (
    db: Database,
    params: WorkflowRunParams,
  ) => Promise<void>;
  readonly embedding: EmbeddingRefreshPort;
  readonly extractImageMetadata: ExtractImageMetadataPort;
  readonly markCalendarFeedDirty: MarkCalendarFeedDirtyPort;
}

export const productionBackgroundTaskPorts: BackgroundTaskPorts = {
  continueWorkflow: async (db, params) =>
    (await import("~/server/workflows/runs/continuation")).continueWorkflowRun(
      db,
      params,
    ),
  embedding: productionEmbeddingRefreshPort,
  extractImageMetadata: productionExtractImageMetadata,
  markCalendarFeedDirty: productionMarkCalendarFeedDirty,
};

/**
 * Run one task against the current database. Shared by the Cloudflare queue
 * consumer and explicit test drains.
 *
 * Every branch re-reads the derived state's own freshness marker before doing
 * work and reports `"skipped"` when there is nothing to do. That, not message
 * identity, is what makes duplicate and out-of-order delivery harmless.
 * Handler modules are imported lazily so the request-time bundle never pulls
 * in the WASM costing engine or the vision client.
 */
export async function handleBackgroundTask(
  db: Database,
  task: BackgroundTask,
  ports: BackgroundTaskPorts = productionBackgroundTaskPorts,
): Promise<BackgroundTaskOutcome> {
  switch (task.kind) {
    case "search-repair.continue": {
      await (
        await import("../runs/search-repair")
      ).continueSearchRepair(db, task);
      return "succeeded";
    }
    case "workflow.continue": {
      await ports.continueWorkflow(db, {
        runId: task.runId,
        attempt: task.attempt,
      });
      return "succeeded";
    }
    case "derived-refresh.wakeup": {
      const { wakeDerivedRefresh } =
        await import("~/server/domains/run/service/derived-refresh");
      await wakeDerivedRefresh(db);
      return "succeeded";
    }
    case "recipe-totals.recompute": {
      const { captureDerivedRefresh } =
        await import("~/server/generic/derived-refresh/repo/capture");
      const { wakeDerivedRefresh } =
        await import("~/server/domains/run/service/derived-refresh");
      await captureDerivedRefresh(
        db,
        task.recipeIds.map((entityId) => ({ entityKind: "recipe", entityId })),
        { invalidate: false },
      );
      await wakeDerivedRefresh(db);
      return "succeeded";
    }
    case "entity-embedding.refresh": {
      const ref = { entityKind: task.entityKind, entityId: task.entityId };
      const result = (
        await refreshEntityEmbeddings(db, [ref], ports.embedding)
      ).get(entityRefKey(ref.entityKind, ref.entityId));
      if (!result) {
        throw new Error(
          `[background-tasks] missing embedding refresh result for ${task.entityKind}:${task.entityId}`,
        );
      }
      if ("error" in result) throw result.error;
      const { outcome } = result;
      if (outcome === "obsolete" || outcome === "unconfigured") {
        log.warn(`embedding ${outcome} ${task.entityKind}:${task.entityId}`);
      }
      return outcome === "written" ? "succeeded" : "skipped";
    }
    case "location-ai.description.refresh": {
      const { describeLocation, isLocationHasNoImagesToAnalyzeError } =
        await import("~/server/ai/enrichment/location-vision");
      const { ensureRun, systemActor } =
        await import("~/server/domains/run/repo/ensure-run");
      try {
        // Attribute to the mutation's actor run when the publisher recorded
        // one; older queue messages (and backfills) carry no `runId`, so
        // those book under the system actor instead of guessing.
        const runId =
          (task.runId ? runEntityId.parse(task.runId) : null) ??
          (await ensureRun(db, systemActor(), {
            purpose: "background",
          }));
        await describeLocation(db, task.locationId, runId);
      } catch (error) {
        if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped";
        throw error;
      }
      return "succeeded";
    }
    case "location-ai.inventory.refresh": {
      const { detectInventoryItems, isLocationHasNoImagesToAnalyzeError } =
        await import("~/server/ai/enrichment/location-vision");
      const { ensureRun, systemActor } =
        await import("~/server/domains/run/repo/ensure-run");
      try {
        const runId =
          (task.runId ? runEntityId.parse(task.runId) : null) ??
          (await ensureRun(db, systemActor(), {
            purpose: "background",
          }));
        await detectInventoryItems(db, task.locationId, runId);
      } catch (error) {
        if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped";
        throw error;
      }
      return "succeeded";
    }
    case "image-processing.wakeup": {
      const { handoffCloudImageTask } =
        await import("~/server/domains/image-processing/service/cloud-queue");
      if (await handoffCloudImageTask(db, task)) return "succeeded";
      const { dispatchImageProcessingWakeup } =
        await import("~/server/domains/image-processing/service/dispatch");
      const outcome = await dispatchImageProcessingWakeup(db, task.jobId);
      return outcome === "skipped" ? "skipped" : "succeeded";
    }
    case "image-processing.result": {
      const { handoffCloudImageTask } =
        await import("~/server/domains/image-processing/service/cloud-queue");
      if (await handoffCloudImageTask(db, task)) return "succeeded";
      const { completeCompanionImageProcessingResult } =
        await import("~/server/domains/image-processing/service/image-processing.service");
      const completion = await completeCompanionImageProcessingResult(
        db,
        task.result,
      );
      return completion.adopted ? "succeeded" : "skipped";
    }
    case "image-metadata.extract":
      return ports.extractImageMetadata(db, task.imageId);
    case "maintenance.recover": {
      const { recoverMissedWork } = await import("~/server/workflows/catch-up");
      await recoverMissedWork(
        db,
        task.coordinatorRetireBefore === undefined
          ? undefined
          : new Date(task.coordinatorRetireBefore),
      );
      return "succeeded";
    }
    case "maintenance.purchase-discovery": {
      const { discoverPurchases } = await import("~/server/workflows/catch-up");
      await discoverPurchases(db);
      return "succeeded";
    }
    case "statement-suggestions.generate":
    case "statement-suggestions.label": {
      const { retiredStatementSuggestionTask } =
        await import("~/server/domains/statement-import/service/statement-suggestion-generation");
      return retiredStatementSuggestionTask();
    }
    case "calendar-feed.mark-dirty": {
      // Propagates a failure on purpose: the queue retries only a throwing
      // handler, and `markDirty` is a flag set, so replay is harmless.
      await ports.markCalendarFeedDirty(task.origin, task.reason);
      return "succeeded";
    }
  }
}
