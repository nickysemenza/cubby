import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { entityRefKey } from "@cubby/schemas/entity";
import type { ImageId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";

import {
  type EmbeddingRefreshPort,
  productionEmbeddingRefreshPort,
  refreshEntityEmbeddings,
} from "./embedding";

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
    await import("~/server/services/image-metadata-extraction.service");
  return extractAndStoreImageMetadata(db, imageId);
};

export interface BackgroundTaskPorts {
  readonly embedding: EmbeddingRefreshPort;
  readonly extractImageMetadata: ExtractImageMetadataPort;
}

export const productionBackgroundTaskPorts: BackgroundTaskPorts = {
  embedding: productionEmbeddingRefreshPort,
  extractImageMetadata: productionExtractImageMetadata,
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
// eslint-disable-next-line complexity -- the switch IS the kind→handler dispatch table; one branch per BackgroundTaskKind, each already as small as its domain call allows.
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
      const { ensureRun, systemActor } =
        await import("~/server/runs/ensure-run");
      try {
        // No actor rides along on a queued background task; this call could
        // originate from a member's mutation side effect or a backfill, but
        // neither carries an actor through the queue message, so it books
        // under the system actor rather than guessing at attribution.
        const runId = await ensureRun(db, systemActor(), {
          purpose: "background",
        });
        await describeLocation(db, task.locationId, runId);
      } catch (error) {
        if (isLocationHasNoImagesToAnalyzeError(error)) return "skipped";
        throw error;
      }
      return "succeeded";
    }
    case "location-ai.inventory.refresh": {
      const { detectInventoryItems, isLocationHasNoImagesToAnalyzeError } =
        await import("~/server/services/ai-enrichment/location-vision");
      const { ensureRun, systemActor } =
        await import("~/server/runs/ensure-run");
      try {
        const runId = await ensureRun(db, systemActor(), {
          purpose: "background",
        });
        await detectInventoryItems(db, task.locationId, runId);
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
    case "image-metadata.extract":
      return ports.extractImageMetadata(db, task.imageId);
    case "maintenance.recover": {
      const { recoverMissedWork } =
        await import("~/server/services/catch-up.service");
      await recoverMissedWork(db);
      return "succeeded";
    }
    case "maintenance.purchase-discovery": {
      const { discoverPurchases } =
        await import("~/server/services/catch-up.service");
      await discoverPurchases(db);
      return "succeeded";
    }
  }
}
