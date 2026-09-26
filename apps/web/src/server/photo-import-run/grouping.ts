import type { ActorContext } from "@cubby/schemas/context";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  assertPhotoRunReviewer,
  listPhotoRunImages,
} from "~/server/photo-import-run/proposals";
import { findActivePurchaseAgentGrant } from "~/server/purchase-import/agent-auth";
import { dispatchImportRunEvent } from "~/server/purchase-import/dispatch";
import { startPhotoInventoryCoordinator } from "~/server/purchase-import/run-service";

/**
 * A coordinator started before descriptions settle sees bare photos and stops
 * for review instead of grouping them. Matches the Apple app's
 * `PhotoReviewPolicy.groupingReadiness`: a description waiting for a capable
 * device is not settled either.
 */
const ANALYSIS_IN_FLIGHT = new Set(["pending", "leased", "waiting_for_device"]);

/** The browser and native clients start the same idempotent coordinator. */
export async function startPhotoGroupingForActor(
  db: Database,
  actorContext: ActorContext,
  actorUserId: string,
  runId: string,
) {
  await assertPhotoRunReviewer(db, actorContext, runId);
  const grant = await findActivePurchaseAgentGrant(db, actorUserId);
  if (!grant) throw new Error("Connect the Cubby agent before grouping photos");
  const queue = getPurchaseAgentQueue();
  if (!queue) throw new Error("Photo import agent is unavailable");
  const waitingForAnalysis = (await listPhotoRunImages(db, runId)).filter(
    (image) =>
      image.targetState === "pending" &&
      image.describe !== null &&
      ANALYSIS_IN_FLIGHT.has(image.describe),
  ).length;
  if (waitingForAnalysis > 0)
    return { runId, started: false, waitingForAnalysis };
  const run = await startPhotoInventoryCoordinator(db, {
    publicId: runId,
    actorUserId,
  });
  if (run.created)
    await dispatchImportRunEvent(db, queue, {
      version: 1,
      runId: run.id,
      eventId: run.eventId,
      purpose: "photo_inventory",
      type: "start_or_resume",
    });
  return { runId: run.publicId, started: run.created, waitingForAnalysis: 0 };
}
