import type { BackgroundTask } from "@cubby/schemas/background-tasks";
import { runEntityId, type ImageId } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
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
  readonly extractImageMetadata: ExtractImageMetadataPort;
  readonly markCalendarFeedDirty: MarkCalendarFeedDirtyPort;
}

export const productionBackgroundTaskPorts: BackgroundTaskPorts = {
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
  task: ExecutableBackgroundTask,
  ports: BackgroundTaskPorts = productionBackgroundTaskPorts,
): Promise<BackgroundTaskOutcome> {
  switch (task.kind) {
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
    case "image-processing.result": {
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
    case "maintenance.purchase-discovery": {
      const { discoverPurchases } = await import("~/server/workflows/catch-up");
      await discoverPurchases(db);
      return "succeeded";
    }
    case "calendar-feed.mark-dirty": {
      // Propagates a failure on purpose: the queue retries only a throwing
      // handler, and `markDirty` is a flag set, so replay is harmless.
      await ports.markCalendarFeedDirty(task.origin, task.reason);
      return "succeeded";
    }
  }
}

export type ExecutableBackgroundTask = Exclude<
  BackgroundTask,
  { kind: "entity-embedding.refresh" | "image-processing.wakeup" }
>;
