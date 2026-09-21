import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { entityRefKey } from "@cubby/schemas/entity";

import type { Database } from "~/server/db";

import {
  type EmbeddingRefreshPort,
  productionEmbeddingRefreshPort,
  refreshEntityEmbeddings,
} from "./embedding";

export type BackgroundTaskOutcome = "succeeded" | "skipped";

export interface BackgroundTaskPorts {
  readonly embedding: EmbeddingRefreshPort;
}

export const productionBackgroundTaskPorts: BackgroundTaskPorts = {
  embedding: productionEmbeddingRefreshPort,
};

/**
 * Run one task against the current database. Shared by the Cloudflare queue
 * consumer and the inline dev path, so both execute identical domain code.
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
    case "recipe-totals.recompute": {
      const { buildCrudServices } = await import("~/server/request-context");
      const { services } = buildCrudServices(db);
      const recomputed = await services.recipeCosting.recomputeQueued(
        task.recipeIds,
      );
      return recomputed > 0 ? "succeeded" : "skipped";
    }
    case "entity-embedding.refresh": {
      const ref = { entityType: task.entityType, entityId: task.entityId };
      const result = (
        await refreshEntityEmbeddings(db, [ref], ports.embedding)
      ).get(entityRefKey(ref.entityType, ref.entityId));
      if (!result) {
        throw new Error(
          `[background-tasks] missing embedding refresh result for ${task.entityType}:${task.entityId}`,
        );
      }
      if ("error" in result) throw result.error;
      const { outcome } = result;
      if (outcome === "obsolete" || outcome === "unconfigured") {
        console.warn(
          `[background-tasks] embedding ${outcome} ${task.entityType}:${task.entityId}`,
        );
      }
      return outcome === "written" ? "succeeded" : "skipped";
    }
    case "location-ai.description.refresh": {
      const { describeLocation, isLocationHasNoImagesToAnalyzeError } =
        await import("~/server/services/ai-enrichment/location-vision");
      try {
        await describeLocation(db, task.locationId);
      } catch (error) {
        if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped";
        throw error;
      }
      return "succeeded";
    }
    case "location-ai.inventory.refresh": {
      const { detectInventoryItems, isLocationHasNoImagesToAnalyzeError } =
        await import("~/server/services/ai-enrichment/location-vision");
      try {
        await detectInventoryItems(db, task.locationId);
      } catch (error) {
        if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped";
        throw error;
      }
      return "succeeded";
    }
    case "image-processing.wakeup": {
      const { dispatchImageProcessingWakeup } =
        await import("~/server/image-processing/dispatch");
      const outcome = await dispatchImageProcessingWakeup(db, task.jobId);
      return outcome === "skipped" ? "skipped" : "succeeded";
    }
    case "image-processing.result": {
      const { completeCompanionImageProcessingResult } =
        await import("~/server/services/image-processing.service");
      const completion = await completeCompanionImageProcessingResult(
        db,
        task.result,
      );
      return completion.adopted ? "succeeded" : "skipped";
    }
  }
}
