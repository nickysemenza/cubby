import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { entityRefKey } from "@cubby/schemas/entity";
import { runEntityId, type ImageId } from "@cubby/schemas/identifiers";
import { createLogger } from "@cubby/worker-tracing";

import type { Database } from "~/server/db";

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
    await import("~/server/services/image-metadata-extraction.service");
  return extractAndStoreImageMetadata(db, imageId);
};

type MarkCalendarFeedDirtyPort = (
  origin: string,
  reason: string,
) => Promise<void>;

const productionMarkCalendarFeedDirty: MarkCalendarFeedDirtyPort = async (
  origin,
  reason,
) => {
  const { calendarFeedStateFor } = await import("~/server/calendar/client");
  await (await calendarFeedStateFor(origin)).markDirty(reason);
};

export interface BackgroundTaskPorts {
  readonly embedding: EmbeddingRefreshPort;
  readonly extractImageMetadata: ExtractImageMetadataPort;
  readonly markCalendarFeedDirty: MarkCalendarFeedDirtyPort;
}

export const productionBackgroundTaskPorts: BackgroundTaskPorts = {
  embedding: productionEmbeddingRefreshPort,
  extractImageMetadata: productionExtractImageMetadata,
  markCalendarFeedDirty: productionMarkCalendarFeedDirty,
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
        await import("~/server/services/ai-enrichment/location-vision");
      const { ensureRun, systemActor } =
        await import("~/server/runs/ensure-run");
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
        await import("~/server/services/ai-enrichment/location-vision");
      const { ensureRun, systemActor } =
        await import("~/server/runs/ensure-run");
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
    case "purchase-import.enrichment-sweep": {
      const [
        { bridgeReachability, sweepPendingEnrichment },
        { getPurchaseImportNamespace },
      ] = await Promise.all([
        import("~/server/purchase-import/enrichment-sweep"),
        import("~/server/cf-env"),
      ]);
      const namespace = getPurchaseImportNamespace();
      const { started } = await sweepPendingEnrichment(db, {
        vendorAccountIds: [task.vendorAccountId],
        bridge: namespace ? bridgeReachability(namespace) : undefined,
      });
      return started.length ? "succeeded" : "skipped";
    }
    case "calendar-feed.mark-dirty": {
      // Propagates a failure on purpose: the queue retries only a throwing
      // handler, and `markDirty` is a flag set, so replay is harmless.
      await ports.markCalendarFeedDirty(task.origin, task.reason);
      return "succeeded";
    }
  }
}
